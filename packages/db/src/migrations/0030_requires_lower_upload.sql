ALTER TABLE "garment_subcategories" ADD COLUMN "requires_lower_upload" boolean NOT NULL DEFAULT false;
ALTER TABLE "job_inputs" ADD COLUMN "lower_garment_key" text;
