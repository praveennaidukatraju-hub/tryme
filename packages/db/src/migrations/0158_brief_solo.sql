CREATE TABLE IF NOT EXISTS "shopify_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"price_usd_cents" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone,
	CONSTRAINT "shopify_usage_events_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "billing_mode" text DEFAULT 'prepaid' NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "payg_spend_cap_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "subscription_is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_usage_events" ADD CONSTRAINT "shopify_usage_events_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_usage_events_store_created_idx" ON "shopify_usage_events" USING btree ("store_id","created_at");