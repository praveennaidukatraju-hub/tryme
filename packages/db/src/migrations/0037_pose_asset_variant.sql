ALTER TABLE "model_pose_assets" ADD COLUMN "pose_variant" text;

-- Backfill from label: extract poseXX suffix (e.g. "face02bg3pose08" → "pose08")
UPDATE "model_pose_assets"
SET "pose_variant" = lower(substring("label" FROM 'pose\d+'))
WHERE "pose_variant" IS NULL
  AND "label" ~ 'pose\d+';
