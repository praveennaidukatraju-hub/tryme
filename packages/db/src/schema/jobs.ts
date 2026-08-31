import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { apiKeys } from './api-keys.js';
import { catalogItems } from './catalog.js';
import { merchants } from './merchant.js';
import { garmentSubcategories, modelBackgrounds, modelFaces, modelPoseAssets } from './models.js';
import { shopifyShoppers, shopifyStores } from './shopify.js';
import { users } from './users.js';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    catalogueId: uuid('catalogue_id'),
    // Groups the jobs created by one POST /v1/jobs/batch. Nullable: every
    // single-job flow leaves it NULL. There is no batches table — batch totals
    // and status are derived by GROUP BY batch_id (see GET /v1/batches/:id).
    batchId: uuid('batch_id'),
    status: text('status').notNull().default('QUEUED'),
    workerId: text('worker_id'),
    priority: boolean('priority').notNull().default(false),
    queueStream: text('queue_stream').notNull().default('normal'),
    // Snapshotted from credit_plans.watermark at job creation; never re-derived from the plan.
    watermark: boolean('watermark').notNull().default(false),
    creditsCharged: integer('credits_charged').notNull().default(1),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    // Which flow created this job. Canonical value set + a matching WORKER_POOL split
    // live in @tryme/types (packages/types/src/job-taxonomy.ts) — see
    // docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md. Null for
    // historical rows not yet backfilled.
    source: text('source'),
    // Nullable self-FK: set only by the regenerate endpoint for traceability.
    parentJobId: uuid('parent_job_id'),
    merchantId: uuid('merchant_id').references(() => merchants.id, {
      onDelete: 'set null',
    }),
    // Set only by /v1/dev/* jobs — stamps which API key created the job so the
    // developer dashboard can report per-key usage without a second credit balance.
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    shopifyStoreId: uuid('shopify_store_id').references(() => shopifyStores.id, {
      onDelete: 'set null',
    }),
    // SET NULL, never CASCADE: retention and GDPR erasure delete shopper rows,
    // but a jobs row is a billing record tied to a credit deduction and a ledger
    // entry. A cascade here would delete billing history.
    shopifyShopperId: uuid('shopify_shopper_id').references(() => shopifyShoppers.id, {
      onDelete: 'set null',
    }),
    customerPhotoKey: text('customer_photo_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set only when a job enters the Redis stream later than it was created —
    // i.e. when an admin releases a HELD bulk-flat batch. NULL means "enqueued at
    // creation", so the sweeper falls back to created_at. See sweeper.ts.
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Duration of the last ComfyUI /prompt round-trip observed for this job (ms).
    // Overwritten per attempt/phase — for two-phase jobs (mannequin + main) this
    // reflects only the most recent phase's comfy call, not a sum. Mirrors the
    // comfy_request_duration_seconds Prometheus histogram; kept in Postgres too so
    // the admin dashboard doesn't need a Grafana Cloud round-trip to render it.
    comfyDurationMs: integer('comfy_duration_ms'),
    // Manual QA flag set from the /results webtool (apps/api/src/modules/results/routes.ts)
    // to mark a job for later review. flagReason is one of the fixed categories validated
    // there; flagNote is an optional free-text detail. Cleared (all four null/false) on unflag.
    flagged: boolean('flagged').notNull().default(false),
    flagReason: text('flag_reason'),
    flagNote: text('flag_note'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    flaggedBy: uuid('flagged_by').references(() => users.id, { onDelete: 'set null' }),
    // Set when a flagged job's issue has been addressed — distinct from unflagging
    // (which clears the flag entirely). A resolved job stays flagged=true so the
    // original reason/note survive for tracking; resolvedAt gates the 'resolved'
    // filter in the /results webtool.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedNote: text('resolved_note'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // Every Shopify analytics query filters on exactly this pair. Without it
    // each one degrades to a sequential scan of every job in the system.
    byShopifyStoreTime: index('jobs_shopify_store_created_idx').on(t.shopifyStoreId, t.createdAt),
    byBatch: index('jobs_batch_idx').on(t.batchId),
    byFlagged: index('jobs_flagged_idx').on(t.flagged),
    byResolved: index('jobs_resolved_idx').on(t.resolvedAt),
    // GET /v1/merchant/tryon/history groups by (merchant_id, day) — without
    // this, that query sequential-scans the whole jobs table as it grows.
    byMerchant: index('jobs_merchant_created_idx').on(t.merchantId, t.createdAt),
  }),
);

export const jobInputs = pgTable('job_inputs', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  upperGarmentKey: text('upper_garment_key'),
  faceId: uuid('face_id').references(() => modelFaces.id),
  backgroundId: uuid('background_id').references(() => modelBackgrounds.id),
  poseId: uuid('pose_id').references(() => modelPoseAssets.id),
  garmentTypeId: uuid('garment_type_id').references(() => garmentSubcategories.id, {
    onDelete: 'set null',
  }),
  lowerCatalogId: uuid('lower_catalog_id').references(() => catalogItems.id),
  lowerGarmentKey: text('lower_garment_key'),
  thirdGarmentKey: text('third_garment_key'),
  shoeCatalogId: uuid('shoe_catalog_id').references(() => catalogItems.id),
  userHint: text('user_hint'),
  params: jsonb('params'),
});

export const jobOutputs = pgTable('job_outputs', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  resultKey: text('result_key'),
  thumbnailKey: text('thumbnail_key'),
  // 'ORIGINAL' | 'WATERMARKED' recorded by finalizeOutput() from actual runtime result.
  assetKind: text('asset_kind').notNull().default('ORIGINAL'),
  // The WatermarkService version used; null when assetKind='ORIGINAL'.
  watermarkVersion: smallint('watermark_version'),
  // Stamped the first time this result is actually downloaded (GET /v1/jobs/:id/result
  // when called from a real download action, not just viewing/zooming) — gates the
  // "regenerate" option, which is disabled once a result has been downloaded. Null =
  // never downloaded. Never cleared once set.
  downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobEvents = pgTable('job_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
