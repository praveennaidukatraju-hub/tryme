-- Replace per-pose allowlists with per-item subcategory targeting.
-- Each lower/shoe catalog item now declares which garment subcategories it
-- applies to; the per-pose showsLower/showsShoes toggle still controls
-- whether the section is shown for a specific pose.

CREATE TABLE catalog_item_subcategories (
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  subcategory_id  uuid NOT NULL REFERENCES garment_subcategories(id) ON DELETE CASCADE,
  PRIMARY KEY (catalog_item_id, subcategory_id)
);

DROP TABLE IF EXISTS pose_catalog_items;
