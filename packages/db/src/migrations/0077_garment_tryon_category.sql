ALTER TABLE "garment_subcategories"
  ADD COLUMN "tryon_category_id" uuid REFERENCES "tryon_categories"("id") ON DELETE SET NULL;
