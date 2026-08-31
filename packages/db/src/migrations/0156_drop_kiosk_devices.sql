ALTER TABLE "jobs" DROP COLUMN "kiosk_device_id";
--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "kiosk_device_id";
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_exactly_one_owner" CHECK (num_nonnulls(user_id, merchant_id) = 1);
--> statement-breakpoint
ALTER TABLE "kiosk_result_likes" DROP COLUMN "kiosk_device_id";
--> statement-breakpoint
ALTER TABLE "kiosk_result_cart_items" DROP COLUMN "kiosk_device_id";
--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "kiosk_enabled";
--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "max_kiosk_devices";
--> statement-breakpoint
DROP TABLE "kiosk_devices";
