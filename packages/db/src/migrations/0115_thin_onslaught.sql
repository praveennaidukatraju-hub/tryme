ALTER TABLE "job_inputs" ADD COLUMN "third_garment_key" text;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "requires_third_upload" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "third_upload_label" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "third_node_id" text;