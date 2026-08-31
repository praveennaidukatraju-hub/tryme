CREATE TABLE IF NOT EXISTS "dev_saree_mannequin_config" (
	"id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000002'::uuid NOT NULL,
	"workflow_template_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dev_saree_mannequin_config" ADD CONSTRAINT "dev_saree_mannequin_config_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
