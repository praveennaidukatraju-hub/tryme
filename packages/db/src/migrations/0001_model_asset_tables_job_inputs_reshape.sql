-- Migration 0001: model asset tables + job_inputs reshape
-- Creates model_faces, model_backgrounds, model_poses tables.
-- Replaces model_catalog_id / pose_catalog_id / background_catalog_id
-- in job_inputs with face_id / pose_id / background_id referencing the
-- new tables. Makes lower_catalog_id nullable, adds shoe_catalog_id.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gender" text NOT NULL,
	"label" text NOT NULL,
	"r2_key" text NOT NULL,
	"thumbnail_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_backgrounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"face_id" uuid NOT NULL,
	"label" text NOT NULL,
	"r2_key" text NOT NULL,
	"thumbnail_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_poses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"background_id" uuid NOT NULL,
	"label" text NOT NULL,
	"r2_key" text NOT NULL,
	"thumbnail_key" text NOT NULL,
	"shows_lower" boolean DEFAULT false NOT NULL,
	"shows_shoes" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_backgrounds" ADD CONSTRAINT "model_backgrounds_face_id_model_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."model_faces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_poses" ADD CONSTRAINT "model_poses_background_id_model_backgrounds_id_fk" FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Drop old FK constraints on job_inputs
ALTER TABLE "job_inputs" DROP CONSTRAINT IF EXISTS "job_inputs_model_catalog_id_catalog_items_id_fk";
--> statement-breakpoint
ALTER TABLE "job_inputs" DROP CONSTRAINT IF EXISTS "job_inputs_pose_catalog_id_catalog_items_id_fk";
--> statement-breakpoint
ALTER TABLE "job_inputs" DROP CONSTRAINT IF EXISTS "job_inputs_background_catalog_id_catalog_items_id_fk";
--> statement-breakpoint
ALTER TABLE "job_inputs" DROP CONSTRAINT IF EXISTS "job_inputs_lower_catalog_id_catalog_items_id_fk";
--> statement-breakpoint
-- Drop old columns
ALTER TABLE "job_inputs" DROP COLUMN IF EXISTS "model_catalog_id";
--> statement-breakpoint
ALTER TABLE "job_inputs" DROP COLUMN IF EXISTS "pose_catalog_id";
--> statement-breakpoint
ALTER TABLE "job_inputs" DROP COLUMN IF EXISTS "background_catalog_id";
--> statement-breakpoint
-- Make lower_catalog_id nullable (was NOT NULL in 0000)
ALTER TABLE "job_inputs" ALTER COLUMN "lower_catalog_id" DROP NOT NULL;
--> statement-breakpoint
-- Add new columns referencing model asset tables
ALTER TABLE "job_inputs" ADD COLUMN IF NOT EXISTS "face_id" uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "job_inputs" ADD COLUMN IF NOT EXISTS "background_id" uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "job_inputs" ADD COLUMN IF NOT EXISTS "pose_id" uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "job_inputs" ADD COLUMN IF NOT EXISTS "shoe_catalog_id" uuid;
--> statement-breakpoint
-- Drop the temporary defaults now that the columns exist (no actual rows in dev)
ALTER TABLE "job_inputs" ALTER COLUMN "face_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "job_inputs" ALTER COLUMN "background_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "job_inputs" ALTER COLUMN "pose_id" DROP DEFAULT;
--> statement-breakpoint
-- Add FK constraints for new columns
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_face_id_model_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."model_faces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_background_id_model_backgrounds_id_fk" FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_pose_id_model_poses_id_fk" FOREIGN KEY ("pose_id") REFERENCES "public"."model_poses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_lower_catalog_id_catalog_items_id_fk" FOREIGN KEY ("lower_catalog_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_shoe_catalog_id_catalog_items_id_fk" FOREIGN KEY ("shoe_catalog_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
