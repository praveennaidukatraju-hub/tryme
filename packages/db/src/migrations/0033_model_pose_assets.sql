-- Create centralised pose asset table
CREATE TABLE "model_pose_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "r2_key" text NOT NULL,
  "face_side_r2_key" text,
  "bg_comfy_r2_key" text,
  "thumbnail_key" text NOT NULL,
  "gender_slug" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Add FK column to model_poses (nullable — existing rows backfilled below)
ALTER TABLE "model_poses" ADD COLUMN "pose_asset_id" uuid REFERENCES "model_pose_assets"("id");

-- Backfill: create one asset row per distinct r2_key, then link mappings
INSERT INTO "model_pose_assets" ("id", "label", "r2_key", "face_side_r2_key", "bg_comfy_r2_key", "thumbnail_key", "created_at")
SELECT DISTINCT ON ("r2_key")
  gen_random_uuid(),
  "label",
  "r2_key",
  "face_side_r2_key",
  "bg_comfy_r2_key",
  "thumbnail_key",
  "created_at"
FROM "model_poses";

UPDATE "model_poses" mp
SET "pose_asset_id" = pa."id"
FROM "model_pose_assets" pa
WHERE mp."r2_key" = pa."r2_key";
