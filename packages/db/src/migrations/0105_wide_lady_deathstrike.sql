ALTER TABLE "model_backgrounds" ADD COLUMN "scope" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN "scope" text DEFAULT 'general' NOT NULL;