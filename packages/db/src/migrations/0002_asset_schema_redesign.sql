-- Migration 0002: asset schema redesign
-- Backgrounds become global (drop face_id).
-- Poses move from per-background to per-subcategory (drop background_id, add subcategory_id).
-- New: garment_subcategories, subcategory_templates.
-- NOTE: Safe on empty dev DB. For prod with data: populate subcategory_id before NOT NULL step.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "garment_subcategories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gender_slug" text NOT NULL,
  "slug" text NOT NULL,
  "label" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subcategory_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subcategory_id" uuid NOT NULL,
  "face_id" uuid NOT NULL,
  "background_id" uuid NOT NULL,
  "r2_key" text NOT NULL,
  "thumbnail_key" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Drop old FK: model_poses.background_id → model_backgrounds.id
ALTER TABLE "model_poses" DROP CONSTRAINT IF EXISTS "model_poses_background_id_model_backgrounds_id_fk";
--> statement-breakpoint
-- Add new column (nullable first)
ALTER TABLE "model_poses" ADD COLUMN IF NOT EXISTS "subcategory_id" uuid;
--> statement-breakpoint
-- Drop old column
ALTER TABLE "model_poses" DROP COLUMN IF EXISTS "background_id";
--> statement-breakpoint
-- Enforce NOT NULL (safe on empty dev DB)
ALTER TABLE "model_poses" ALTER COLUMN "subcategory_id" SET NOT NULL;
--> statement-breakpoint
-- Drop old FK: model_backgrounds.face_id → model_faces.id
ALTER TABLE "model_backgrounds" DROP CONSTRAINT IF EXISTS "model_backgrounds_face_id_model_faces_id_fk";
--> statement-breakpoint
ALTER TABLE "model_backgrounds" DROP COLUMN IF EXISTS "face_id";
--> statement-breakpoint
-- FK constraints for new tables and column
DO $$ BEGIN
  ALTER TABLE "model_poses" ADD CONSTRAINT "model_poses_subcategory_id_garment_subcategories_id_fk"
    FOREIGN KEY ("subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subcategory_templates" ADD CONSTRAINT "subcategory_templates_subcategory_id_fk"
    FOREIGN KEY ("subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subcategory_templates" ADD CONSTRAINT "subcategory_templates_face_id_fk"
    FOREIGN KEY ("face_id") REFERENCES "public"."model_faces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subcategory_templates" ADD CONSTRAINT "subcategory_templates_background_id_fk"
    FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_poses_subcategory_id_idx" ON "model_poses" ("subcategory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcategory_templates_subcategory_id_idx" ON "subcategory_templates" ("subcategory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcategory_templates_lookup_idx" ON "subcategory_templates" ("subcategory_id", "face_id", "background_id");
--> statement-breakpoint
-- Replace the non-unique index with a unique one (run only if index already exists from earlier migration)
DROP INDEX IF EXISTS "subcategory_templates_lookup_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subcategory_templates_lookup_idx" ON "subcategory_templates" ("subcategory_id", "face_id", "background_id");
