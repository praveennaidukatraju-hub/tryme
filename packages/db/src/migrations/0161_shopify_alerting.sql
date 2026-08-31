ALTER TABLE "shopify_stores" ADD COLUMN "shop_email" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "last_alert_level" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "last_alert_at" timestamp with time zone;
