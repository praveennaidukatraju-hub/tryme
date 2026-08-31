-- When a bulk-flat batch is HELD, the job row is written immediately but only
-- enters the Redis stream when an admin releases it — potentially days later.
-- The dispatcher's stuck-job sweeper measures QUEUED staleness from created_at,
-- which would fail-and-refund a healthy job on the first tick after release.
-- queued_at records when the job actually entered the stream; the sweeper
-- prefers it over created_at. NULL for every job enqueued at creation time,
-- which preserves the existing behaviour exactly.
ALTER TABLE "jobs" ADD COLUMN "queued_at" timestamp with time zone;
