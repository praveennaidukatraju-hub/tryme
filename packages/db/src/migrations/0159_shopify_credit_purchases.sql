CREATE TABLE "shopify_credit_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_charge_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"pack_id" text NOT NULL,
	"credits" integer NOT NULL,
	"price_usd_cents" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_credit_purchases" ADD CONSTRAINT "shopify_credit_purchases_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "shopify_credit_purchases_store_idx" ON "shopify_credit_purchases" USING btree ("store_id");
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_pack_id" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_trigger_credits" integer;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_capped_amount_cents" integer;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_status" text;
--> statement-breakpoint
-- At most one auto-refill purchase may be in flight per store. Half of the
-- double-charge guard (the other half is a pg_advisory_xact_lock in phase 3);
-- this is the database-level backstop that survives a refactor moving the lock.
CREATE UNIQUE INDEX "shopify_credit_purchases_one_pending_autorefill" ON "shopify_credit_purchases" USING btree ("store_id") WHERE "status" = 'PENDING' AND "source" = 'autorefill';
