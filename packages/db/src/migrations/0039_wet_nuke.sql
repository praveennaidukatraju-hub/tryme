ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "pose_variant" text;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "face_id" uuid;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "background_id" uuid;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "workflow_template_id" uuid;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "prompt_garment_phase" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_pose_assets" ADD CONSTRAINT "model_pose_assets_face_id_model_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."model_faces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_pose_assets" ADD CONSTRAINT "model_pose_assets_background_id_model_backgrounds_id_fk" FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_pose_assets" ADD CONSTRAINT "model_pose_assets_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_poses" ADD CONSTRAINT "model_poses_pose_asset_id_model_pose_assets_id_fk" FOREIGN KEY ("pose_asset_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
