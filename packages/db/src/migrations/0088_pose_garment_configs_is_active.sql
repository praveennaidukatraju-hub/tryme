-- Per-garment-type active override for pose assets. Null = inherit
-- model_pose_assets.is_active (the global flag). Non-null overrides it for
-- this garment type only.
ALTER TABLE "pose_garment_configs" ADD COLUMN IF NOT EXISTS "is_active" boolean;
