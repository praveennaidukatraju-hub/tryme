import { z } from 'zod';

// z.string().url().optional() rejects '' — it only tolerates a truly absent
// key. A .env file with `FOO=` sets FOO to '', not undefined, so every
// optional URL var needs this to actually be skippable.
const optionalUrl = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('debug'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
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
  /** Public-facing base URL for presigned GET URLs handed to third parties (e.g.
   *  PixVerse fetching a source image), e.g. https://app.tryme.com/minio.
   *  When set, the internal endpoint origin in the generated URL is replaced with
   *  this value. Same var api's storage plugin already uses. */
  R2_PUBLIC_PRESIGN_BASE: optionalUrl(),
  DISPATCHER_HEALTH_PORT: z.coerce.number().default(4100),
  // How long a pending stream entry must be idle before recovery claims it (ms)
  XPENDING_CLAIM_THRESHOLD_MS: z.coerce.number().default(60_000),
  SENTRY_DSN: optionalUrl(),
  ENABLE_WATERMARKING: z.coerce.boolean().default(true),
  PIXVERSE_API_KEY: z.string().optional(),
  PIXVERSE_API_BASE_URL: z.string().url().default('https://app-api.pixverse.ai'),
  PIXVERSE_POLL_INTERVAL_MS: z.coerce.number().default(5_000),
  PIXVERSE_POLL_TIMEOUT_MS: z.coerce.number().default(180_000),
  /** In-flight cap for the PixVerse video lane (jobs:video). Independent of the GPU
   *  worker registry — catalog-video jobs never touch ComfyUI. Should match the
   *  concurrency limit of the PixVerse plan. Restart the dispatcher to change it. */
  VIDEO_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(5),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(): Env {
  return Env.parse(process.env);
}
