-- Add face_id and background_id to model_poses
-- Poses are per (subcategory × face × background) combo, e.g. m1bg1p1

ALTER TABLE model_poses
  ADD COLUMN face_id UUID REFERENCES model_faces(id),
  ADD COLUMN background_id UUID REFERENCES model_backgrounds(id);

-- Dev DB has no rows so safe to set NOT NULL immediately
ALTER TABLE model_poses
  ALTER COLUMN face_id SET NOT NULL,
  ALTER COLUMN background_id SET NOT NULL;

CREATE INDEX model_poses_face_id_idx ON model_poses(face_id);
CREATE INDEX model_poses_background_id_idx ON model_poses(background_id);
