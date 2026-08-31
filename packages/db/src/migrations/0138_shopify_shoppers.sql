CREATE TABLE IF NOT EXISTS "shopify_shoppers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL REFERENCES "shopify_stores"("id") ON DELETE cascade,
  "client_id" text NOT NULL,
  "shopify_customer_id" bigint,
  "email" text,
  "email_consent" boolean DEFAULT false NOT NULL,
  "email_captured_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_shoppers_store_id_client_id_unique" UNIQUE("store_id","client_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_shoppers_store_email_idx" ON "shopify_shoppers" ("store_id","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_shoppers_store_customer_idx" ON "shopify_shoppers" ("store_id","shopify_customer_id");
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "shopify_shopper_id" uuid REFERENCES "shopify_shoppers"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN IF NOT EXISTS "iana_timezone" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_shopify_shopper_idx" ON "jobs" ("shopify_shopper_id") WHERE "shopify_shopper_id" IS NOT NULL;
