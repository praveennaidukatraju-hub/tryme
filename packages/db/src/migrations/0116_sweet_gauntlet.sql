CREATE TABLE IF NOT EXISTS "shopify_catalog_jobs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_product_id" bigint NOT NULL,
	"source_image_url" text NOT NULL,
	"shopify_media_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_catalog_jobs" ADD CONSTRAINT "shopify_catalog_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_catalog_jobs" ADD CONSTRAINT "shopify_catalog_jobs_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
