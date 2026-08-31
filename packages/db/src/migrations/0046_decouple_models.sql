-- Phase 1: add ComfyUI-specific image columns to face and background rows
ALTER TABLE "model_faces" ADD COLUMN "face_side_r2_key" text;--> statement-breakpoint
ALTER TABLE "model_backgrounds" ADD COLUMN "bg_comfy_r2_key" text;--> statement-breakpoint

-- Phase 2: drop NOT NULL + FK constraints on model_poses.face_id and background_id
-- (data will be null-ed out after the data migration script runs)
ALTER TABLE "model_poses" DROP CONSTRAINT IF EXISTS "model_poses_face_id_model_faces_id_fk";--> statement-breakpoint
ALTER TABLE "model_poses" DROP CONSTRAINT IF EXISTS "model_poses_background_id_model_backgrounds_id_fk";--> statement-breakpoint
ALTER TABLE "model_poses" ALTER COLUMN "face_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_poses" ALTER COLUMN "background_id" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_poses" ADD CONSTRAINT "model_poses_face_id_model_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."model_faces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_poses" ADD CONSTRAINT "model_poses_background_id_model_backgrounds_id_fk" FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
