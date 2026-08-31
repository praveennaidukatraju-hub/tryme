ALTER TABLE "users" ADD COLUMN "default_resolution" text DEFAULT 'HD' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_aspect_ratio" text DEFAULT '1:1' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_platform" text DEFAULT 'Amazon' NOT NULL;
