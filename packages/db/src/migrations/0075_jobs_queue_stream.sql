ALTER TABLE "jobs" ADD COLUMN "queue_stream" text NOT NULL DEFAULT 'normal';

-- Backfill existing rows from the lossy priority boolean
UPDATE "jobs" SET "queue_stream" = 'priority' WHERE "priority" = true;
