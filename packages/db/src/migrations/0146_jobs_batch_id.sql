ALTER TABLE "jobs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
CREATE INDEX "jobs_batch_idx" ON "jobs" USING btree ("batch_id");
