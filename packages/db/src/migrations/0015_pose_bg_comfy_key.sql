-- Add per-pose ComfyUI background image key to model_poses
ALTER TABLE "model_poses"
  ADD COLUMN IF NOT EXISTS "bg_comfy_r2_key" text;
