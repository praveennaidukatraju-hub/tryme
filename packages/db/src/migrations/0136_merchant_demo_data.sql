ALTER TABLE "merchants" ADD COLUMN "demo_data" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "merchants" SET "demo_data" = false;
