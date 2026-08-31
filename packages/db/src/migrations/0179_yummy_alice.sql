ALTER TABLE "api_keys" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "integration" text DEFAULT 'generic' NOT NULL;