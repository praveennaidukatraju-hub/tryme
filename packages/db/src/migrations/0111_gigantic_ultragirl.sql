CREATE TABLE IF NOT EXISTS "garment_shot_type_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"garment_type_id" uuid NOT NULL,
	"shot_type" text NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garment_shot_type_workflows_garment_type_shot_type_unique" UNIQUE("garment_type_id","shot_type")
);
--> statement-breakpoint
ALTER TABLE "catalogue_template_pose_workflows" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN "shot_type" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_shot_type_workflows" ADD CONSTRAINT "garment_shot_type_workflows_garment_type_id_garment_subcategories_id_fk" FOREIGN KEY ("garment_type_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_shot_type_workflows" ADD CONSTRAINT "garment_shot_type_workflows_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "garment_shot_type_workflows_garment_type_id_idx" ON "garment_shot_type_workflows" USING btree ("garment_type_id");