-- Seed one Style 1 row matching whatever mannequin workflow saree garment
-- types already use in production, so existing merchants see one pre-selected
-- style and nothing changes for them until an admin adds Style 2. No-op on
-- a fresh/empty database (nothing to seed from yet).
INSERT INTO saree_mannequin_styles (label, mannequin_workflow_template_id, sort_order, is_active)
SELECT 'Style 1', gs.mannequin_workflow_template_id, 0, true
FROM garment_subcategories gs
WHERE gs.requires_mannequin_step = true AND gs.mannequin_workflow_template_id IS NOT NULL
LIMIT 1;
