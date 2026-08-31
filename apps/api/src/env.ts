import { z } from 'zod';

// z.string().url().optional() rejects '' — it only tolerates a truly absent
// key. A .env file with `FOO=` sets FOO to '', not undefined, so every
// optional URL var needs this to actually be skippable.
const optionalUrl = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('debug'),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRY: z.string().default('1h'),
  R2_ENDPOINT: z.string().url(),
  R2_ACCESS_KEY_ID: z.string(),
  R2_SECRET_ACCESS_KEY: z.string(),
  R2_BUCKET: z.string(),
  R2_PUBLIC_URL: z.string().url(),
  R2_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  /** Endpoint used for presigned URL signing (SigV4 Host header). Set to the public
   *  domain when MinIO is behind a reverse proxy so the signed Host matches the
   *  header forwarded by Nginx. Falls back to R2_ENDPOINT when omitted. */
  R2_SIGN_ENDPOINT: optionalUrl(),
  /** Public-facing base URL for browser-side presigned uploads, e.g. https://rankplex.cloud/minio */
  R2_PUBLIC_PRESIGN_BASE: optionalUrl(),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(8).optional(),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /**
   * Number of reverse proxies in front of this process, passed to Fastify's
   * `trustProxy`. Production is Cloudflare -> nginx -> api, so 2; a bare local
   * run has none. Wrong-but-too-high is the dangerous direction — it lets a
   * client prepend its own X-Forwarded-For entry and choose the IP we attribute
   * the request to — so this is explicit config rather than a guess, and
   * defaults to 0 (trust nothing).
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  COOKIE_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: optionalUrl(),
  // Extra accepted `aud` values for POST /v1/auth/device-login/google, comma-separated.
  // Normally unset: the Android ID token's aud is GOOGLE_CLIENT_ID (the Web client ID
  // passed to Credential Manager as serverClientId).
  GOOGLE_DEVICE_AUDIENCES: z.string().optional(),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1).default('noreply@tryme.com'),
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  SENTRY_DSN: optionalUrl(),
  CHATBOT_URL: optionalUrl(),
  CHATBOT_SERVICE_TOKEN: z.string().optional(),
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  // Used to build the OAuth redirect_uri (/v1/shopify/auth/callback) and the
  // webhook callback base — must be a host that proxies /v1/* to this API.
  // Note there is deliberately no "where is the SPA served" counterpart: the
  // post-install redirect goes back through Shopify (admin.shopify.com/store/
  // .../apps/...) so that Shopify re-opens the app with the host/id_token params
  // App Bridge requires. Never redirect at the SPA's own URL directly.
  SHOPIFY_APP_URL: optionalUrl(),
  SHOPIFY_SCOPES: z.string().default('read_products'),
  // 32-byte key, base64-encoded (44 chars). Required only when Shopify is enabled.
  SHOPIFY_TOKEN_ENC_KEY: z.string().optional(),
  // 32-byte key, base64-encoded (44 chars). Required only when Google Drive
  // export is enabled. Same encryptToken/decryptToken helper as the line
  // above, different key — see lib/crypto.ts.
  GOOGLE_DRIVE_TOKEN_ENC_KEY: z.string().optional(),
  // Grant credits for Shopify *test* one-time charges (AppPurchaseOneTime.test),
  // which is what every development store produces — Shopify never bills them.
  // Off unless the value is exactly 'true', so production grants only against
  // money that actually moved; set it on staging/dev so the paid flow stays
  // testable there.
  //
  // Deliberately not z.coerce.boolean() like R2_FORCE_PATH_STYLE above:
  // coercion follows JS truthiness, so the string 'false' — the obvious way to
  // write "off" in a .env — coerces to true. That failure mode is silent and
  // hands out free product, so this one accepts only the literal 'true'.
  SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS: z.preprocess((v) => v === 'true', z.boolean()).default(false),
  // Comma-separated email allowlist for the Catalog Video (PixVerse) feature.
  // Unset = open to everyone (dev default). Set in production to restrict the
  // feature to a soft-launch cohort without a code change.
  CATALOG_VIDEO_ALLOWED_EMAILS: z.string().optional(),
});
export type Env = z.infer<typeof Env>;
export function loadEnv(): Env {
  return Env.parse(process.env);
}
