CREATE INDEX IF NOT EXISTS "jobs_queued_idx" ON "jobs" ("status") WHERE "status" = 'QUEUED';
