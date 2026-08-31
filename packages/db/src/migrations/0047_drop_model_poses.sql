-- Add new columns to model_pose_assets
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "prompt_face_phase" text;

-- Drop old FK first so we can UPDATE pose_id to model_pose_assets UUIDs without violating it
ALTER TABLE "job_inputs" DROP CONSTRAINT IF EXISTS "job_inputs_pose_id_model_poses_id_fk";

-- Remap job_inputs.pose_id from model_poses.id → model_pose_assets.id
UPDATE job_inputs ji
SET pose_id = mp.pose_asset_id
FROM model_poses mp
WHERE ji.pose_id = mp.id
  AND mp.pose_asset_id IS NOT NULL;

-- Null out any job_inputs.pose_id that still reference old model_poses UUIDs
-- (rows where model_poses had no pose_asset_id, so the remap above didn't touch them)
UPDATE job_inputs
SET pose_id = NULL
WHERE pose_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_pose_assets WHERE id = job_inputs.pose_id);

-- Add new FK pointing to model_pose_assets
ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_pose_id_model_pose_assets_id_fk"
  FOREIGN KEY ("pose_id") REFERENCES "model_pose_assets"("id");

-- Drop model_poses table
DROP TABLE IF EXISTS "model_poses";

-- Drop now-unused columns from model_pose_assets
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "face_id";
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "background_id";
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "face_side_r2_key";
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "bg_comfy_r2_key";
