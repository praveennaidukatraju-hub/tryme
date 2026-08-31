-- 0146_jobs_batch_id.sql added jobs.batch_id as a bare grouping UUID (see
-- createBatch.ts: "there is no batches table" — progress is derived via
-- GROUP BY batch_id, nothing ever writes a row for it elsewhere). Staging
-- and prod were separately found with a "jobs_batch_id_fkey" FK to a
-- "tryon_batches" table that appears nowhere in this repo's migration
-- history — leftover from an earlier, abandoned design, added directly to
-- the DB outside the normal migration path. It rejects every batch job
-- insert with a foreign key violation.
--
-- A first version of this migration (plain DROP TABLE, no CASCADE) failed
-- on prod: "credit_ledger_batch_id_fkey" also depends on tryon_batches —
-- another leftover from the same abandoned design, on a table/column that
-- packages/db/src/schema/credits.ts doesn't model either. CASCADE removes
-- every dependent constraint found; it leaves credit_ledger.batch_id itself
-- in place as a harmless, unconstrained, unused column, since the app
-- schema never referenced it.
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_batch_id_fkey";--> statement-breakpoint
DROP TABLE IF EXISTS "tryon_batches" CASCADE;
