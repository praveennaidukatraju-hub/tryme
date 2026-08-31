ALTER TABLE "job_outputs" ADD COLUMN "downloaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "flag_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "flag_note" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "flagged_by" uuid;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "regeneration_reason_prompts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_flagged_by_users_id_fk" FOREIGN KEY ("flagged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_flagged_idx" ON "jobs" USING btree ("flagged");