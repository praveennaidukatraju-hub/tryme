ALTER TABLE "shopify_plans" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "shopify_plans" CASCADE;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_stores" DROP CONSTRAINT "shopify_stores_shopify_plan_id_shopify_plans_id_fk";
EXCEPTION
 WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_stores" ADD CONSTRAINT "shopify_stores_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN IF EXISTS "billing_plan_id";--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN IF EXISTS "shopify_plan_id";