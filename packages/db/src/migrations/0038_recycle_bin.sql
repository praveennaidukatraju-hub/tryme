ALTER TABLE "model_faces" ADD COLUMN "deleted_at" timestamp with time zone;
ALTER TABLE "model_backgrounds" ADD COLUMN "deleted_at" timestamp with time zone;
ALTER TABLE "model_pose_assets" ADD COLUMN "deleted_at" timestamp with time zone;
