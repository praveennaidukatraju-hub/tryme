ALTER TABLE "model_poses"
  ADD COLUMN IF NOT EXISTS "workflow_template" text NOT NULL DEFAULT 'twopiece',
  ADD COLUMN IF NOT EXISTS "prompt_face_phase" text,
  ADD COLUMN IF NOT EXISTS "prompt_garment_phase" text,
  ADD COLUMN IF NOT EXISTS "face_side_r2_key" text;
