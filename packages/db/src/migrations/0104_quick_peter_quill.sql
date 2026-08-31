CREATE TABLE IF NOT EXISTS "catalogue_template_looks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"pose_asset_id" uuid NOT NULL,
	"background_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gender_slug" text NOT NULL,
	"label" text NOT NULL,
	"thumbnail_key" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_looks" ADD CONSTRAINT "catalogue_template_looks_template_id_catalogue_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."catalogue_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_looks" ADD CONSTRAINT "catalogue_template_looks_pose_asset_id_model_pose_assets_id_fk" FOREIGN KEY ("pose_asset_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_looks" ADD CONSTRAINT "catalogue_template_looks_background_id_model_backgrounds_id_fk" FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalogue_template_looks_template_id_idx" ON "catalogue_template_looks" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "website_url";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "company_size";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "purpose";