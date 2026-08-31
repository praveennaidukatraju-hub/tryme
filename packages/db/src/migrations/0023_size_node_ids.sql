ALTER TABLE workflow_templates
  ADD COLUMN IF NOT EXISTS size_node_ids text[] NOT NULL DEFAULT '{}';
