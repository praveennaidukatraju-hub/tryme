-- Production has exactly one widget_clients row with no linked user (a dev's
-- own test signup, id eea16fa9-a19c-41e0-bc7e-b4d2ebd785d7, company "nice",
-- nice@nd.com) — predates the user_id column existing at all. The NOT NULL
-- below requires every row to have one; this row has no real data to preserve
-- (confirmed test-only), so it's removed here rather than backfilled. Cascades
-- to any dependent kiosk_devices/merchant_catalog_items/credits/etc. rows.
DELETE FROM "widget_clients" WHERE "id" = 'eea16fa9-a19c-41e0-bc7e-b4d2ebd785d7' AND "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "widget_clients" DROP CONSTRAINT "widget_clients_email_key";--> statement-breakpoint
ALTER TABLE "widget_clients" DROP CONSTRAINT "widget_clients_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "widget_clients" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_clients" DROP COLUMN IF EXISTS "email";--> statement-breakpoint
ALTER TABLE "widget_clients" DROP COLUMN IF EXISTS "password_hash";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "widget_clients" ADD CONSTRAINT "widget_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "widget_clients" ADD CONSTRAINT "widget_clients_user_id_unique" UNIQUE("user_id");
