ALTER TABLE saree_settings
  ADD COLUMN workflow_template_id uuid REFERENCES workflow_templates(id) ON DELETE SET NULL;
