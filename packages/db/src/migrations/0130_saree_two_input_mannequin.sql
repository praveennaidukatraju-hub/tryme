ALTER TABLE "garment_subcategories" ADD COLUMN IF NOT EXISTS "mannequin_two_input_workflow_template_id" uuid REFERENCES "workflow_templates"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "tryon_garment_node_id_2" text;
