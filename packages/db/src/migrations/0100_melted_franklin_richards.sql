CREATE TABLE IF NOT EXISTS "shopify_funnel_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"funnel_template_id" uuid NOT NULL,
	"mode" text DEFAULT 'manual' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_funnel_rules_store_id_funnel_template_id_unique" UNIQUE("store_id","funnel_template_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_funnel_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_funnel_templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"included_tryons" integer NOT NULL,
	"overage_cents" integer NOT NULL,
	"trial_days" integer DEFAULT 7 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_product_garments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_product_id" bigint NOT NULL,
	"shopify_variant_id" bigint,
	"r2_key" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"failed_reason" text,
	"funnel_template_id" uuid,
	"funnel_assignment_source" text,
	"product_type" text,
	"tags" text[],
	"vendor" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_product_garments_store_id_shopify_product_id_shopify_variant_id_unique" UNIQUE("store_id","shopify_product_id","shopify_variant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"allowed_origins" text[] DEFAULT '{}' NOT NULL,
	"shop_domain" text NOT NULL,
	"shopify_shop_id" bigint NOT NULL,
	"access_token" text NOT NULL,
	"scope" text NOT NULL,
	"billing_plan_id" bigint,
	"shopify_plan_id" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_stores_store_key_unique" UNIQUE("store_key"),
	CONSTRAINT "shopify_stores_shop_domain_unique" UNIQUE("shop_domain"),
	CONSTRAINT "shopify_stores_shopify_shop_id_unique" UNIQUE("shopify_shop_id")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "shopify_store_id" uuid;--> statement-breakpoint
-- Already added by 0088_pose_garment_configs_is_active.sql; the pre-existing snapshot
-- gap (see 0090_backfill_migration_history.sql) made drizzle-kit re-detect it as new.
-- Guarded so this migration is a safe no-op for that column everywhere it already exists.
ALTER TABLE "pose_garment_configs" ADD COLUMN IF NOT EXISTS "is_active" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_funnel_rules" ADD CONSTRAINT "shopify_funnel_rules_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_funnel_rules" ADD CONSTRAINT "shopify_funnel_rules_funnel_template_id_shopify_funnel_templates_id_fk" FOREIGN KEY ("funnel_template_id") REFERENCES "public"."shopify_funnel_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_funnel_templates" ADD CONSTRAINT "shopify_funnel_templates_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_product_garments" ADD CONSTRAINT "shopify_product_garments_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_product_garments" ADD CONSTRAINT "shopify_product_garments_funnel_template_id_shopify_funnel_templates_id_fk" FOREIGN KEY ("funnel_template_id") REFERENCES "public"."shopify_funnel_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_stores" ADD CONSTRAINT "shopify_stores_shopify_plan_id_shopify_plans_id_fk" FOREIGN KEY ("shopify_plan_id") REFERENCES "public"."shopify_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_shopify_store_id_shopify_stores_id_fk" FOREIGN KEY ("shopify_store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
