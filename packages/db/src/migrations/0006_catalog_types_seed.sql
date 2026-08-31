-- seed catalog types for lower garments and shoes
INSERT INTO catalog_types (slug, label)
VALUES
  ('lower', 'Lower Garments'),
  ('shoe', 'Shoes')
ON CONFLICT (slug) DO NOTHING;

--> statement-breakpoint

-- seed gender categories under "lower"
INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'women-lower', 'Women', 1, true
  FROM catalog_types t WHERE t.slug = 'lower'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'women-lower'
  );

INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'men-lower', 'Men', 2, true
  FROM catalog_types t WHERE t.slug = 'lower'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'men-lower'
  );

INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'girls-lower', 'Girls', 3, true
  FROM catalog_types t WHERE t.slug = 'lower'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'girls-lower'
  );

INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'boys-lower', 'Boys', 4, true
  FROM catalog_types t WHERE t.slug = 'lower'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'boys-lower'
  );

--> statement-breakpoint

-- seed gender categories under "shoe"
INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'women-shoe', 'Women', 1, true
  FROM catalog_types t WHERE t.slug = 'shoe'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'women-shoe'
  );

INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'men-shoe', 'Men', 2, true
  FROM catalog_types t WHERE t.slug = 'shoe'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'men-shoe'
  );

INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'girls-shoe', 'Girls', 3, true
  FROM catalog_types t WHERE t.slug = 'shoe'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'girls-shoe'
  );

INSERT INTO catalog_categories (type_id, parent_id, slug, label, sort_order, is_active)
SELECT t.id, NULL, 'boys-shoe', 'Boys', 4, true
  FROM catalog_types t WHERE t.slug = 'shoe'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.type_id = t.id AND c.slug = 'boys-shoe'
  );
