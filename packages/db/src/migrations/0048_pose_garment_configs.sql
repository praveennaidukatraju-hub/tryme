-- Per-garment-type workflow/prompt overrides for pose assets
CREATE TABLE "pose_garment_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pose_asset_id" uuid NOT NULL REFERENCES "model_pose_assets"("id") ON DELETE CASCADE,
  "subcategory_id" uuid NOT NULL REFERENCES "garment_subcategories"("id") ON DELETE CASCADE,
  "workflow_template_id" uuid REFERENCES "workflow_templates"("id") ON DELETE SET NULL,
  "prompt_garment_phase" text,
  "prompt_face_phase" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pose_garment_configs_pose_subcat_unique" UNIQUE ("pose_asset_id", "subcategory_id")
);

CREATE INDEX "pose_garment_configs_pose_asset_id_idx" ON "pose_garment_configs" ("pose_asset_id");
CREATE INDEX "pose_garment_configs_subcategory_id_idx" ON "pose_garment_configs" ("subcategory_id");

-- Add garmentTypeId to job_inputs for dispatcher config lookup
ALTER TABLE "job_inputs" ADD COLUMN IF NOT EXISTS "garment_type_id" uuid REFERENCES "garment_subcategories"("id") ON DELETE SET NULL;
