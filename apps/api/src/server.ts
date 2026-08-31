import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import * as Sentry from '@sentry/node';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { and, eq, isNull, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Env } from './env.js';
import { AppError } from './lib/errors.js';
import { isShopifyPreviewOrigin } from './lib/shopify-origin.js';
import { adminAuditRoutes } from './modules/admin/audit.routes.js';
import { adminAuthRoutes } from './modules/admin/auth.routes.js';
import { adminCatalogRoutes } from './modules/admin/catalog.routes.js';
import { adminCatalogueTemplatesRoutes } from './modules/admin/catalogue-templates.routes.js';
import { adminChatbotRoutes } from './modules/admin/chatbot.routes.js';
import { adminConfigRoutes } from './modules/admin/config.routes.js';
import { adminContactRoutes } from './modules/admin/contact.routes.js';
import { adminCreditAnalysisRoutes } from './modules/admin/credit-analysis.routes.js';
import { adminCreditPlansRoutes } from './modules/admin/creditPlans.routes.js';
import { adminCreditsRoutes } from './modules/admin/credits.routes.js';
import { adminDemoCatalogRoutes } from './modules/admin/demo-catalog.routes.js';
import { adminDevApiRoutes } from './modules/admin/dev-api.routes.js';
import { adminHeldJobsRoutes } from './modules/admin/held-jobs.routes.js';
import { adminJobsRoutes } from './modules/admin/jobs.routes.js';
import { adminMeRoutes } from './modules/admin/me.routes.js';
import { adminMerchantCatalogRoutes } from './modules/admin/merchant-catalog.routes.js';
import { adminMerchantsRoutes } from './modules/admin/merchants.routes.js';
import { adminAssetsRoutes } from './modules/admin/models.routes.js';
import { adminPaymentsRoutes } from './modules/admin/payments.routes.js';
import { adminRolePermissionsRoutes } from './modules/admin/role-permissions.routes.js';
import { adminSareeRoutes } from './modules/admin/saree.routes.js';
import { adminShopifyFunnelsRoutes } from './modules/admin/shopify-funnels.routes.js';
import { adminShopifyStoresRoutes } from './modules/admin/shopify-stores.routes.js';
import { adminSignupCampaignsRoutes } from './modules/admin/signupCampaigns.routes.js';
import { adminGarmentTypesRoutes } from './modules/admin/subcategories.routes.js';
import { adminTelemetryRoutes } from './modules/admin/telemetry.routes.js';
import { adminTryonRoutes } from './modules/admin/tryon.routes.js';
import { adminUsersRoutes } from './modules/admin/users.routes.js';
import { adminWorkersRoutes } from './modules/admin/workers.routes.js';
import { adminWorkflowsRoutes } from './modules/admin/workflows.routes.js';
import { googleAuthRoutes } from './modules/auth/google.routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { backgroundsRoutes } from './modules/backgrounds/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { creditsRoutes } from './modules/credits/routes.js';
import { devCatalogRoutes } from './modules/dev/catalog.routes.js';
import { devRoutes } from './modules/dev/routes.js';
import { googleDriveRoutes } from './modules/google-drive/routes.js';
import { jobsRoutes } from './modules/jobs/routes.js';
import { merchantApiKeysRoutes } from './modules/merchant/api-keys.routes.js';
import { merchantCatalogRoutes } from './modules/merchant/catalog.routes.js';
import { kioskDownloadRoutes } from './modules/merchant/kiosk-download.routes.js';
import { merchantMeRoutes } from './modules/merchant/me.routes.js';
import { merchantOnboardingRoutes } from './modules/merchant/onboarding.routes.js';
import { merchantPaymentsRoutes } from './modules/merchant/payments.routes.js';
import { merchantTryonRoutes } from './modules/merchant/tryon.routes.js';
import { merchantTryonResultsRoutes } from './modules/merchant/tryon-results.routes.js';
import { merchantUploadSessionRoutes } from './modules/merchant/upload-sessions.routes.js';
import { modelsRoutes } from './modules/models/routes.js';
import { paymentsRoutes } from './modules/payments/routes.js';
import { posePresetsRoutes } from './modules/pose-presets/routes.js';
import { resultsRoutes } from './modules/results/routes.js';
import { shopifyCustomerRoutes } from './modules/shopify/customer.routes.js';
import { shopifyRoutes } from './modules/shopify/routes.js';
import { supportRoutes } from './modules/support/routes.js';
import { uploadsRoutes } from './modules/uploads/routes.js';
import { authPlugin } from './plugins/auth.js';
import { catalogCacheInvalidationPlugin } from './plugins/catalog-cache-invalidation.js';
import { dbPlugin } from './plugins/db.js';
import { devApiAuthPlugin } from './plugins/dev-api-auth.js';
import { metricsPlugin } from './plugins/metrics.js';
import { portalAuthPlugin } from './plugins/portal-auth.js';
import { redisPlugin } from './plugins/redis.js';
import { sentryPlugin } from './plugins/sentry.js';
import { shopifyAuthPlugin } from './plugins/shopify-auth.js';
import { shopifyWidgetAuthPlugin } from './plugins/shopify-widget-auth.js';
import { storagePlugin } from './plugins/storage.js';

// Scalar renders info.description as markdown on the /v1/dev/docs "Introduction" page.
// The quickstart is maintained as a standalone doc (readable outside a running server,
// linkable from GitHub) — read it in as the single source of truth rather than
// duplicating its content as an inline string here.
const DEV_API_QUICKSTART_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../dev-api-quickstart.md',
);

// Regenerated by `pnpm --filter @tryme/api postman:generate` from this same
// OpenAPI spec — see src/scripts/generate-postman.ts. Lives under apps/api/
// (not docs/) because .dockerignore excludes docs/ wholesale from the build
// context, and Docker's negation rules can't re-include a file once its
// parent directory is excluded.
const POSTMAN_COLLECTION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../postman/tryme-dev-api.postman_collection.json',
);

function loadDevApiDescription(): string {
  try {
    // Drop the leading H1 — Scalar already renders info.title above this description.
    return readFileSync(DEV_API_QUICKSTART_PATH, 'utf8').replace(/^#[^\n]*\n+/, '');
  } catch {
    return 'Generate a virtual try-on image from a person image and a garment image.';
  }
}

export async function buildServer(env: Env) {
  // Behind a reverse proxy on the VPS — without this every request's req.ip
  // resolves to the proxy's own loopback address, so @fastify/rate-limit
  // buckets all traffic together as a single client instead of per real
  // client IP. Not `true`: that would trust the whole X-Forwarded-For chain,
  // letting a client prepend a value of its choosing and pick its own bucket.
  //
  // The count is the number of proxies in front of us. Production is
  // Cloudflare -> nginx -> here, so req.ip alone still resolves to a
  // Cloudflare edge address rather than the visitor; the rate limiter's
  // keyGenerator below prefers CF-Connecting-IP for exactly that reason.
  const app = Fastify({
    loggerInstance: createLogger('api'),
    trustProxy: env.TRUST_PROXY_HOPS,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('env', env);

  const r2Origin = new URL(env.R2_PUBLIC_URL).origin;
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', r2Origin],
        'connect-src': ["'self'", r2Origin],
        // Scalar's docs page (/v1/dev/docs) inlines a static bootstrap script
        // (Scalar.createApiReference(...)) — hash-pin it rather than 'unsafe-inline'.
        'script-src': ["'self'", "'sha256-cWTMliztqFgvzhAh79uXn6mME2QZ5F1J5/jIafVbm1M='"],
      },
    },
  });
  // In-process TTL cache in front of the shopifyStores allowed-origins lookup below.
  // Without it, every cross-origin request whose Origin isn't env.CORS_ORIGIN (every
  // Shopify storefront request, every preflight, any attacker-supplied Origin) triggers
  // a full Postgres query. 30s staleness is an accepted tradeoff (see CLAUDE.md task notes);
  // this is not a cache-invalidation-on-write system.
  const originCache = new Map<string, { allowed: boolean; expiresAt: number }>();
  const ORIGIN_CACHE_TTL_MS = 30_000;
  const ORIGIN_CACHE_MAX_ENTRIES = 10_000;

  await app.register(cors, {
    origin: async (origin: string | undefined) => {
      if (!origin) return false;
      if (env.CORS_ORIGIN.includes(origin)) return true;
      if (isShopifyPreviewOrigin(origin)) return true;

      const now = Date.now();
      const cached = originCache.get(origin);
      if (cached && cached.expiresAt > now) return cached.allowed;

      const [shopifyRow] = await app.db
        .select({ id: schema.shopifyStores.id })
        .from(schema.shopifyStores)
        .where(
          and(
            isNull(schema.shopifyStores.uninstalledAt),
            sql`${origin} = ANY(${schema.shopifyStores.allowedOrigins})`,
          ),
        )
        .limit(1);

      // Mirrors the shopifyStores check above, one row per WordPress widget key
      // instead of an array column (one widget key is expected per site — see
      // api-keys.ts's allowedOrigin comment). Without this, every WooCommerce
      // storefront's widget.js is CORS-blocked calling /v1/dev/tryon directly.
      const [wordpressRow] = shopifyRow
        ? []
        : await app.db
            .select({ id: schema.apiKeys.id })
            .from(schema.apiKeys)
            .where(
              and(
                eq(schema.apiKeys.integration, 'wordpress'),
                isNull(schema.apiKeys.revokedAt),
                eq(schema.apiKeys.allowedOrigin, origin),
              ),
            )
            .limit(1);
      const allowed = !!shopifyRow || !!wordpressRow;
      // Cap unbounded growth from a flood of distinct attacker-supplied Origins; a full
      // clear is simple and fine since worst case is a handful of extra DB hits.
      if (originCache.size >= ORIGIN_CACHE_MAX_ENTRIES) originCache.clear();
      originCache.set(origin, { allowed, expiresAt: now + ORIGIN_CACHE_TTL_MS });
      return allowed;
    },
    credentials: true,
  });
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(redisPlugin);
  // After redisPlugin — the hook bumps a Redis counter. Before the admin routes it
  // watches, though ordering against them is not strictly required since it is
  // registered with fastify-plugin and therefore applies app-wide.
  await app.register(catalogCacheInvalidationPlugin);
  // Distinct per server instance, only in test: the integration suite runs many
  // files back-to-back against one shared real Redis instance, all injecting
  // from the same default IP. Without this, unrelated test files' request
  // volume piles into the same rate-limit bucket over real wall-clock time and
  // produces spurious 429s. Salting the key per instance isolates each test
  // file's app from every other's, while still bucketing by IP *within* one
  // instance/file — so a test that deliberately varies its own remoteAddress
  // (e.g. a test asserting the Nth attempt from one IP gets rate-limited) is
  // unaffected.
  const rateLimitTestSalt = env.NODE_ENV === 'test' ? randomUUID() : '';
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    redis: app.redis,
    // A brief Redis blip should never itself turn into a wall of 500s across the
    // whole API — rate-limiting is a safety net, not a critical path. Paired with
    // app.redis's bounded maxRetriesPerRequest (see plugins/redis.ts) so a blip
    // fails fast (and therefore open) instead of hanging.
    skipOnError: true,
    // req.ip resolves to a Cloudflare edge address in production, and Cloudflare
    // spreads one visitor across many edge IPs while funnelling many visitors
    // through each. Bucketing on it therefore does both wrong things at once:
    // unrelated traffic shares a limit, and a single client's requests scatter
    // across buckets. CF-Connecting-IP is the visitor address Cloudflare
    // attaches, so prefer it and fall back to req.ip wherever the header is
    // absent (local dev, direct-to-origin health checks).
    keyGenerator: (req) => {
      const cf = req.headers['cf-connecting-ip'];
      const ip = (typeof cf === 'string' && cf) || req.ip;
      return rateLimitTestSalt ? `${rateLimitTestSalt}:${ip}` : ip;
    },
    allowList: (req) =>
      (req.url.startsWith('/admin/') && !req.url.startsWith('/admin/auth/')) ||
      req.url === '/v1/payments/webhook' ||
      // Shopify's own OAuth/webhook traffic — already authenticated per-request
      // (HMAC, state nonce, or webhook signature) rather than by this bucket, and
      // a shared-traffic 429 here reads to Shopify as "app failed to install" /
      // turns into needless webhook redelivery, not just a slower response.
      req.url.startsWith('/v1/shopify/webhooks/') ||
      req.url.startsWith('/v1/shopify/auth'),
  });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 2.5 * 1024 * 1024 * 1024 } });
  await app.register(metricsPlugin);

  await app.register(sentryPlugin);
  await app.register(dbPlugin);
  await app.register(storagePlugin);
  await app.register(authPlugin);
  await app.register(portalAuthPlugin);
  await app.register(shopifyAuthPlugin);
  await app.register(shopifyWidgetAuthPlugin);
  await app.register(devApiAuthPlugin);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Try-On API',
        description: loadDevApiDescription(),
        version: '1.0.0',
      },
      // Scalar renders this as a base-URL picker on the docs page and in the
      // "Test Request" panel, so switching environments there doesn't require
      // editing anything -- unlike the copy-paste $API_URL in the quickstart doc,
      // which is necessarily static text. Localhost is dev-only noise on the
      // public prod docs page, so it's only listed outside production.
      // Prod and staging are both always listed (both are public, known hostnames,
      // and NODE_ENV=production on staging too -- see .env.staging.example -- so
      // there's no env flag to gate this on). Localhost stays dev-only noise off
      // the hosted docs page.
      servers: [
        { url: 'https://app.tryme.com', description: 'Production' },
        { url: 'https://staging-app.tryme.com', description: 'Staging' },
        ...(env.NODE_ENV === 'production'
          ? []
          : [{ url: 'http://localhost:4000', description: 'Local development' }]),
      ],
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'Your sk_live_… API key' },
        },
      },
      security: [{ apiKey: [] }],
    },
    // The spec is public, so it must describe ONLY the developer surface. Every
    // route without the 'dev' tag is hidden — admin/auth/merchant routes must never
    // appear here.
    transform: ({ schema: s, url }) => {
      const out = jsonSchemaTransform({ schema: s, url });
      if (!s?.tags?.includes('dev')) out.schema = { ...out.schema, hide: true };
      return out;
    },
  });
  await app.register(scalar, {
    routePrefix: '/v1/dev/docs',
    // hiddenClients: true drops the whole "Client Libraries" language picker --
    // the quickstart doc (dev-api-quickstart.md, this page's own description)
    // already covers curl/Node with the full multi-call flow.
    configuration: { url: '/v1/dev/openapi.json', hiddenClients: true },
  });
  app.get('/v1/dev/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/v1/dev/postman-collection.json', { schema: { hide: true } }, async (_req, reply) => {
    try {
      return JSON.parse(readFileSync(POSTMAN_COLLECTION_PATH, 'utf8'));
    } catch {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'collection not generated yet' } });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      app.log.warn(
        { code: err.code, statusCode: err.statusCode, msg: err.message, url: _req.url },
        'app error',
      );
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
    }
    if ((err as { validation?: unknown }).validation) {
      app.log.warn({ err, url: _req.url, body: _req.body }, 'validation error');
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION', message: (err as Error).message } });
    }
    // Postgres unique_violation. A duplicate value the caller supplied is a client
    // error, not a 500 — the concrete case this exists for is two assets given the
    // same public_api_slug (migration 0130), where the admin needs to be told which
    // constraint they hit rather than seeing "internal error".
    if ((err as { code?: unknown }).code === '23505') {
      const constraint = (err as { constraint_name?: string }).constraint_name;
      app.log.warn({ err, constraint, url: _req.url }, 'unique violation');
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: constraint ? `value already in use (${constraint})` : 'value already in use',
        },
      });
    }
    // Generic framework 4xx (e.g. @fastify/rate-limit's 429) — must come AFTER the
    // validation branch, which also carries statusCode 400 but has its own contract.
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      app.log.warn({ err, statusCode, url: _req.url }, 'client error');
      return reply.code(statusCode).send({
        error: {
          code: statusCode === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR',
          message: (err as Error).message,
        },
      });
    }
    Sentry.captureException(err);
    app.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  await app.register(authRoutes);
  await app.register(googleAuthRoutes);
  await app.register(creditsRoutes);
  await app.register(catalogRoutes);
  await app.register(uploadsRoutes);
  await app.register(backgroundsRoutes);
  await app.register(jobsRoutes);
  await app.register(googleDriveRoutes);
  await app.register(posePresetsRoutes);
  await app.register(merchantCatalogRoutes);
  await app.register(merchantOnboardingRoutes);
  await app.register(merchantTryonRoutes);
  await app.register(merchantMeRoutes);
  await app.register(merchantTryonResultsRoutes);
  await app.register(merchantUploadSessionRoutes);
  await app.register(kioskDownloadRoutes);
  await app.register(merchantPaymentsRoutes);
  await app.register(merchantApiKeysRoutes);
  await app.register(devRoutes);
  await app.register(devCatalogRoutes);
  await app.register(shopifyRoutes);
  await app.register(shopifyCustomerRoutes);
  await app.register(modelsRoutes);
  await app.register(adminAuditRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminUsersRoutes);
  await app.register(adminRolePermissionsRoutes);
  await app.register(adminCreditsRoutes);
  await app.register(adminCreditPlansRoutes);
  await app.register(adminCreditAnalysisRoutes);
  await app.register(adminPaymentsRoutes);
  await app.register(adminSignupCampaignsRoutes);
  await app.register(adminCatalogRoutes);
  await app.register(adminChatbotRoutes);
  await app.register(adminHeldJobsRoutes);
  await app.register(adminJobsRoutes);
  await app.register(adminMerchantCatalogRoutes);
  await app.register(adminDemoCatalogRoutes);
  await app.register(adminWorkersRoutes);
  await app.register(adminConfigRoutes);
  await app.register(adminTelemetryRoutes);
  await app.register(adminMeRoutes);
  await app.register(adminAssetsRoutes);
  await app.register(adminGarmentTypesRoutes);
  await app.register(adminCatalogueTemplatesRoutes);
  await app.register(adminShopifyFunnelsRoutes);
  await app.register(adminShopifyStoresRoutes);
  await app.register(adminWorkflowsRoutes);
  await app.register(adminTryonRoutes);
  await app.register(adminDevApiRoutes);
  await app.register(adminSareeRoutes);
  await app.register(adminContactRoutes);
  await app.register(adminMerchantsRoutes);
  await app.register(resultsRoutes);
  await app.register(supportRoutes);
  await app.register(paymentsRoutes);

  app.get('/health', async () => ({ status: 'ok' }));
  return app as unknown as FastifyInstance;
}
