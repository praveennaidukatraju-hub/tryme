CREATE TABLE IF NOT EXISTS "catalogue_template_pose_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"pose_asset_id" uuid NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_template_pose_workflows_mapping_pose_unique" UNIQUE("mapping_id","pose_asset_id")
);
--> statement-breakpoint
ALTER TABLE "catalogue_template_subcategories" DROP CONSTRAINT "catalogue_template_subcategories_template_id_subcategory_id_pk";--> statement-breakpoint
ALTER TABLE "catalogue_template_subcategories" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_pose_workflows" ADD CONSTRAINT "catalogue_template_pose_workflows_mapping_id_catalogue_template_subcategories_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."catalogue_template_subcategories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_pose_workflows" ADD CONSTRAINT "catalogue_template_pose_workflows_pose_asset_id_model_pose_assets_id_fk" FOREIGN KEY ("pose_asset_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_pose_workflows" ADD CONSTRAINT "catalogue_template_pose_workflows_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalogue_template_pose_workflows_mapping_id_idx" ON "catalogue_template_pose_workflows" USING btree ("mapping_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalogue_template_subcategories_subcategory_id_idx" ON "catalogue_template_subcategories" USING btree ("subcategory_id");--> statement-breakpoint
ALTER TABLE "catalogue_template_subcategories" ADD CONSTRAINT "catalogue_template_subcategories_template_subcategory_unique" UNIQUE("template_id","subcategory_id");