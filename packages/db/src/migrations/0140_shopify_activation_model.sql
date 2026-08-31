ALTER TABLE "shopify_product_garments" ADD COLUMN IF NOT EXISTS "excluded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "title" text NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_collections_store_id_shopify_collection_id_unique" UNIQUE("store_id","shopify_collection_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_collection_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "shopify_product_id" bigint NOT NULL,
  CONSTRAINT "shopify_collection_products_store_id_shopify_collection_id_shopify_product_id_unique" UNIQUE("store_id","shopify_collection_id","shopify_product_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_enabled_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_enabled_collections_store_id_shopify_collection_id_unique" UNIQUE("store_id","shopify_collection_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_excluded_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_excluded_collections_store_id_shopify_collection_id_unique" UNIQUE("store_id","shopify_collection_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_collections" ADD CONSTRAINT "shopify_collections_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_collection_products" ADD CONSTRAINT "shopify_collection_products_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_enabled_collections" ADD CONSTRAINT "shopify_enabled_collections_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_excluded_collections" ADD CONSTRAINT "shopify_excluded_collections_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_collection_products_store_product_idx" ON "shopify_collection_products" ("store_id","shopify_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_collection_products_store_collection_idx" ON "shopify_collection_products" ("store_id","shopify_collection_id");
