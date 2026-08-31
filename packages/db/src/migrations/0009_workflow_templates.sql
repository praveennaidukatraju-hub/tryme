-- Step 1: Clear existing poses (user confirmed OK to lose them)
TRUNCATE TABLE "model_poses" CASCADE;

-- Step 2: Remove old workflow column (IF EXISTS — safe if already dropped)
ALTER TABLE "model_poses"
  DROP COLUMN IF EXISTS "workflow_template";

-- Step 3: Create workflow_templates table (BEFORE adding FK to model_poses)
CREATE TABLE IF NOT EXISTS "workflow_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text UNIQUE NOT NULL,
  "label" text NOT NULL,
  "json_content" jsonb NOT NULL,

  -- Node ID mappings
  "face_node_id" text NOT NULL,
  "pose_node_id" text NOT NULL,
  "bg_node_id" text NOT NULL,
  "upper_node_ids" text[] NOT NULL,
  "lower_node_id" text,

  -- Prompt nodes
  "face_phase_prompt_node" text NOT NULL,
  "garment_phase_prompt_node" text NOT NULL,

  -- Default prompts (extracted from JSON at upload time)
  "default_face_phase_prompt" text NOT NULL DEFAULT '',
  "default_garment_phase_prompt" text NOT NULL DEFAULT '',

  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_templates_active_idx" ON "workflow_templates" ("is_active");
-- Step 4: Add FK column to poses (IF NOT EXISTS — safe on re-run)
ALTER TABLE "model_poses"
  ADD COLUMN IF NOT EXISTS "workflow_template_id" uuid NOT NULL REFERENCES "workflow_templates"("id");

CREATE INDEX IF NOT EXISTS "model_poses_workflow_template_id_idx" ON "model_poses" ("workflow_template_id");
