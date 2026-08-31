-- Reuse the generic catalog_categories table for background categories,
-- the same mechanism already used for lower-garment/shoe categories.
INSERT INTO "catalog_types" ("slug", "label")
VALUES ('background', 'Backgrounds')
ON CONFLICT ("slug") DO NOTHING;

-- Nullable: existing backgrounds keep category_id = NULL ("Uncategorized").
ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "category_id" integer REFERENCES "catalog_categories"("id");
