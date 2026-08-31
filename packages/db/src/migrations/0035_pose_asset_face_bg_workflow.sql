ALTER TABLE "model_pose_assets"
  ADD COLUMN "face_id" uuid REFERENCES "model_faces"("id") ON DELETE SET NULL,
  ADD COLUMN "background_id" uuid REFERENCES "model_backgrounds"("id") ON DELETE SET NULL,
  ADD COLUMN "workflow_template_id" uuid REFERENCES "workflow_templates"("id") ON DELETE SET NULL,
  ADD COLUMN "prompt_garment_phase" text;
