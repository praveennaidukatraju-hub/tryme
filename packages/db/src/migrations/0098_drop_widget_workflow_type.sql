-- The 'widget' workflow category is retired: kiosk now resolves its ComfyUI
-- workflow via tryon_categories, same as the studio Try-On feature. The only
-- workflow_type='widget' rows in any environment are throwaway smoke-test
-- seed data (confirmed zero FK references from model_pose_assets,
-- pose_garment_configs, or tryon_categories) — safe to delete outright.
DELETE FROM "workflow_templates" WHERE "workflow_type" = 'widget';--> statement-breakpoint
ALTER TABLE "workflow_templates" DROP COLUMN IF EXISTS "widget_garment_node_id";--> statement-breakpoint
ALTER TABLE "workflow_templates" DROP COLUMN IF EXISTS "widget_customer_photo_node_id";--> statement-breakpoint
ALTER TABLE "workflow_templates" DROP COLUMN IF EXISTS "widget_output_node_id";