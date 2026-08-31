ALTER TABLE "credit_plans" DROP COLUMN IF EXISTS "per_photo_price_label";--> statement-breakpoint
ALTER TABLE "credit_plans" DROP COLUMN IF EXISTS "per_tryon_price_label";--> statement-breakpoint
ALTER TABLE "credit_plans" DROP COLUMN IF EXISTS "tryon_unit_label";--> statement-breakpoint
ALTER TABLE "credit_plans" ADD COLUMN "plan_type" text NOT NULL DEFAULT 'catalogue';--> statement-breakpoint
ALTER TABLE "credit_plans" ADD COLUMN "per_unit_price_label" text;--> statement-breakpoint
ALTER TABLE "credit_plans" ADD COLUMN "unit_count_label" text;
