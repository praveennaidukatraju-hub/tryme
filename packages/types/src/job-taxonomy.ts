import { z } from 'zod';

// The fine-grained "what created this job" taxonomy — stored in jobs.source.
// See docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md.
export const JOB_SOURCE = {
  CATALOG: 'catalog',
  TRYON: 'tryon',
  CATALOG_VIDEO: 'catalog_video',
  SAREE: 'saree',
  SAREE_MANNEQUIN: 'saree_mannequin',
  SHOPIFY: 'shopify',
  MERCHANT_CATALOG: 'merchant_catalog',
  MERCHANT_CATALOG_SAREE_MANNEQUIN: 'merchant_catalog_saree_mannequin',
  MERCHANT_TRYON: 'merchant_tryon',
  API_TRYON: 'api_tryon',
  API_SAREE_MANNEQUIN: 'api_saree_mannequin',
  API_CATALOG: 'api_catalog',
  WORDPRESS_TRYON: 'wordpress_tryon',
} as const;
export type JobSource = (typeof JOB_SOURCE)[keyof typeof JOB_SOURCE];
export const jobSourceSchema = z.enum(Object.values(JOB_SOURCE) as [JobSource, ...JobSource[]]);

// Not part of JobSource — deliberately excluded from jobSourceSchema and every
// exhaustiveness check over JOB_SOURCE, so a switch/map keyed by JobSource can't
// accidentally treat 'api' as a live value a writer might still produce. No writer
// in this codebase can produce this value after the dev-API three-way split ships
// (see the dev/ job creators) — it exists solely so the permanent legacy-inclusion
// read filters (apps/api/src/modules/dev/routes.ts, dev/catalog.routes.ts,
// merchant/api-keys.routes.ts) reference a named export instead of a repeated raw
// string literal.
export const LEGACY_JOB_SOURCE = {
  API: 'api',
} as const;

// The coarse "which admin-managed worker capability" split — the only thing
// workers.allowed_job_types and the dispatcher's selectWorker() compare against.
// No source-to-pool mapping exists: merchant_catalog jobs claim two different
// pools sequentially depending on job_inputs.params.needsMannequinStep, which no
// static per-source table can express (see the design spec §9). Every dispatcher
// call site keeps claiming the specific pool its own phase needs, unchanged from
// today's behavior — only the string literal's origin changes.
export const WORKER_POOL = {
  CATALOGUE: 'catalogue',
  TRYON: 'tryon',
  SAREE: 'saree',
  SHOPIFY: 'shopify',
  MERCHANT: 'merchant',
} as const;
export type WorkerPool = (typeof WORKER_POOL)[keyof typeof WORKER_POOL];
export const workerPoolSchema = z.enum(Object.values(WORKER_POOL) as [WorkerPool, ...WorkerPool[]]);
