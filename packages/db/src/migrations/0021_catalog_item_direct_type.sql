-- Add type column directly to catalog_items, populated from category chain
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "type" text;

UPDATE "catalog_items" ci
SET "type" = ct.slug
FROM "catalog_categories" cc
JOIN "catalog_types" ct ON cc.type_id = ct.id
WHERE ci.category_id = cc.id;

UPDATE "catalog_items" SET "type" = 'lower' WHERE "type" IS NULL;

ALTER TABLE "catalog_items" ALTER COLUMN "type" SET NOT NULL;

-- Make category_id nullable (items can now exist without a category)
ALTER TABLE "catalog_items" ALTER COLUMN "category_id" DROP NOT NULL;
