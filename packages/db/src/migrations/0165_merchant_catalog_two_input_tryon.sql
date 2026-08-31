ALTER TABLE "merchant_catalog_items" ADD COLUMN "second_r2_key" text;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "second_thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "two_input_tryon_workflow_template_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_two_input_tryon_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("two_input_tryon_workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
