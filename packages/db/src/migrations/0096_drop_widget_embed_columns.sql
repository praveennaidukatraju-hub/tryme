ALTER TABLE "merchants" DROP CONSTRAINT "merchants_widget_key_key";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "widget_key";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "allowed_origins";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "settings";