CREATE TABLE IF NOT EXISTS "shopify_widget_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "store_id" uuid NOT NULL,
  "client_id" text,
  "shopify_product_id" bigint,
  "type" text NOT NULL,
  "device" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_widget_events" ADD CONSTRAINT "shopify_widget_events_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_widget_events_store_time_idx" ON "shopify_widget_events" ("store_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_widget_events_store_type_time_idx" ON "shopify_widget_events" ("store_id","type","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_widget_events_store_product_time_idx" ON "shopify_widget_events" ("store_id","shopify_product_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_shopify_store_created_idx" ON "jobs" ("shopify_store_id","created_at");
