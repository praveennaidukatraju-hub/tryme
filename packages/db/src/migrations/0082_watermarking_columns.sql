-- Migration: 0082_watermarking_columns
-- Adds watermarking capability columns as specified in the Free-Tier Watermarking spec.
-- All changes are purely additive (new columns with defaults) — zero downtime.

-- 1. credit_plans.watermark: plan-level capability flag.
--    Default false so existing paid plans remain non-watermarking.
--    Immediately UPDATE the free plan to watermark=true.
ALTER TABLE "credit_plans" ADD COLUMN "watermark" boolean NOT NULL DEFAULT false;
UPDATE "credit_plans" SET "watermark" = true WHERE "slug" = 'free';

-- 2. jobs.watermark: snapshot of the plan's watermark flag at job creation time.
--    Same shape/lifecycle as jobs.queue_stream — resolved once, never re-derived.
--    Default false so all historical jobs stay ORIGINAL (they were not watermarked).
ALTER TABLE "jobs" ADD COLUMN "watermark" boolean NOT NULL DEFAULT false;

-- 3. jobs.parent_job_id: nullable self-FK, set only by the regenerate endpoint.
--    Traceability for support/analytics; no entitlement logic depends on it.
ALTER TABLE "jobs" ADD COLUMN "parent_job_id" uuid;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_fkey"
  FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id");

-- 4. job_outputs.asset_kind: observed outcome after finalization.
--    Values: 'ORIGINAL' | 'WATERMARKED'. Written by finalizeOutput(), never elsewhere.
--    Default 'ORIGINAL' so all existing outputs remain correctly classified.
ALTER TABLE "job_outputs" ADD COLUMN "asset_kind" text NOT NULL DEFAULT 'ORIGINAL';

-- 5. job_outputs.watermark_version: the WatermarkService algorithm version applied.
--    null when asset_kind = 'ORIGINAL'. Allows historical attribution to specific watermark designs.
ALTER TABLE "job_outputs" ADD COLUMN "watermark_version" smallint;
