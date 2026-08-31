ALTER TABLE "workflow_templates"
  ADD COLUMN "latent_size_node_ids" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "latent_max_px" integer NOT NULL DEFAULT 2048,
  ADD COLUMN "output_size_node_ids" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "output_max_px" integer NOT NULL DEFAULT 1024,
  ADD COLUMN "result_node_id" text;
