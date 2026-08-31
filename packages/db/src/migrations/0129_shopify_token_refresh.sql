ALTER TABLE "shopify_stores" ADD COLUMN IF NOT EXISTS "refresh_token" text;--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp with time zone;
