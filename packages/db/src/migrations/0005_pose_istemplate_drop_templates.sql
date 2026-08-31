-- Add isTemplate to model_poses
ALTER TABLE model_poses ADD COLUMN is_template boolean NOT NULL DEFAULT false;

-- Partial unique index: only one template per (subcategory × face × background) cell
CREATE UNIQUE INDEX model_poses_template_idx
  ON model_poses (subcategory_id, face_id, background_id)
  WHERE is_template = true;

-- Drop the now-redundant subcategory_templates table
DROP TABLE IF EXISTS subcategory_templates CASCADE;
