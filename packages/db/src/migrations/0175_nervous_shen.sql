CREATE TABLE IF NOT EXISTS "workflow_template_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"json_content" jsonb NOT NULL,
	"face_node_id" text,
	"pose_node_id" text NOT NULL,
	"bg_node_id" text,
	"upper_node_ids" text[] NOT NULL,
	"lower_node_id" text,
	"shoe_node_id" text,
	"third_node_id" text,
	"size_node_id" text,
	"size_node_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"latent_size_node_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"latent_max_px" integer DEFAULT 2048 NOT NULL,
	"output_size_node_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"output_max_px" integer DEFAULT 2048 NOT NULL,
	"result_node_id" text,
	"face_phase_prompt_node" text,
	"garment_phase_prompt_node" text NOT NULL,
	"stage1_positive_prompt_node" text,
	"stage1_negative_prompt_node" text,
	"default_face_phase_prompt" text DEFAULT '' NOT NULL,
	"default_garment_phase_prompt" text DEFAULT '' NOT NULL,
	"default_stage1_positive_prompt" text DEFAULT '' NOT NULL,
	"default_stage1_negative_prompt" text DEFAULT '' NOT NULL,
	"workflow_type" text DEFAULT 'regular' NOT NULL,
	"tryon_person_node_id" text,
	"tryon_garment_node_id" text,
	"tryon_garment_node_id_2" text,
	"tryon_output_node_id" text,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_template_archives_template_unique" UNIQUE("workflow_template_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_template_archives" ADD CONSTRAINT "workflow_template_archives_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_template_archives_template_version_idx" ON "workflow_template_archives" USING btree ("workflow_template_id","version");