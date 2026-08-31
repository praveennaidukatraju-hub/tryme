ALTER TABLE "garment_subcategories" ADD COLUMN "requires_mannequin_step" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "mannequin_workflow_template_id" uuid;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "saree_step2_workflow_template_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_mannequin_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("mannequin_workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_saree_step2_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("saree_step2_workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
