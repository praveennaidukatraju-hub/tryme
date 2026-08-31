DROP INDEX IF EXISTS model_poses_template_idx;
ALTER TABLE model_poses DROP COLUMN IF EXISTS is_template;
