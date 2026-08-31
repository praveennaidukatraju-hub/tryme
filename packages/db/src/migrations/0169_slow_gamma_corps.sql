-- user_pose_presets shipped in migration 0168 without gender/garmentTypeId
-- scoping. Poses are gender-partitioned and have per-garment-type
-- active/inactive overrides, so a preset saved under one context is
-- meaningless under another — this was caught immediately after merge,
-- before any real user data existed, so it's a clean drop+recreate rather
-- than a backfill migration.
DROP TABLE IF EXISTS "user_pose_presets";--> statement-breakpoint
CREATE TABLE "user_pose_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"gender" text NOT NULL,
	"garment_type_id" uuid NOT NULL,
	"pose_ids" uuid[] NOT NULL,
	"is_last_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_pose_presets" ADD CONSTRAINT "user_pose_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_pose_presets" ADD CONSTRAINT "user_pose_presets_garment_type_id_garment_subcategories_id_fk" FOREIGN KEY ("garment_type_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_pose_presets_one_last_used_idx" ON "user_pose_presets" USING btree ("user_id","gender","garment_type_id") WHERE "user_pose_presets"."is_last_used";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_pose_presets_unique_name_idx" ON "user_pose_presets" USING btree ("user_id","gender","garment_type_id","name") WHERE NOT "user_pose_presets"."is_last_used";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_pose_presets_user_id_idx" ON "user_pose_presets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_pose_presets_scope_idx" ON "user_pose_presets" USING btree ("user_id","gender","garment_type_id");
