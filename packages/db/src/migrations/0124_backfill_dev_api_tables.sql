-- Backfill dev_tryon_categories from the currently-active internal tryon_categories.
-- Idempotent: ON CONFLICT (slug) DO NOTHING so re-running is safe. Copies slug,
-- name, workflow, sort order — the fields the dev endpoint resolves and lists.
INSERT INTO dev_tryon_categories (name, slug, workflow_template_id, sort_order, is_active)
SELECT name, slug, workflow_template_id, sort_order, TRUE
FROM tryon_categories
WHERE is_active = TRUE
ON CONFLICT (slug) DO NOTHING;

-- Seed the single dev saree-mannequin config row from whichever garment
-- subcategory currently drives the internal mannequin step (exactly one today:
-- Flat Saree, requires_mannequin_step = TRUE). Fixed sentinel id, idempotent.
INSERT INTO dev_saree_mannequin_config (id, workflow_template_id, is_active)
SELECT
  '00000000-0000-0000-0000-000000000002'::uuid,
  gsc.mannequin_workflow_template_id,
  TRUE
FROM garment_subcategories gsc
WHERE gsc.requires_mannequin_step = TRUE
  AND gsc.mannequin_workflow_template_id IS NOT NULL
  AND gsc.is_active = TRUE
ORDER BY gsc.id
LIMIT 1
ON CONFLICT (id) DO NOTHING;
