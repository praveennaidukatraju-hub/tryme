ALTER TABLE "saree_mannequin_styles" ADD COLUMN IF NOT EXISTS "mannequin_two_input_workflow_template_id" uuid REFERENCES "workflow_templates"("id") ON DELETE set null;
