ALTER TABLE "shopify_stores" DROP COLUMN "plan_handle";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "subscription_status";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "current_subscription_id";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "current_period_end";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "last_billing_sync_at";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "billing_mode";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "payg_spend_cap_usd_cents";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "subscription_is_test";
--> statement-breakpoint
DROP TABLE "shopify_usage_events";
