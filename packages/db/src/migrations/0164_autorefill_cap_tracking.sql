ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_balance_used_cents" integer;--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_cap_warned_at" timestamp with time zone;