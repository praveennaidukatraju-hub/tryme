ALTER TABLE "workflow_templates"
  ADD COLUMN "workflow_type" text NOT NULL DEFAULT 'regular',
  ADD COLUMN "widget_garment_node_id" text,
  ADD COLUMN "widget_customer_photo_node_id" text,
  ADD COLUMN "widget_output_node_id" text;
