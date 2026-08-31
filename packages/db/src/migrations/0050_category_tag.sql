-- Optional badge tag on catalog_categories (used by background categories: featured/trending/popular).
ALTER TABLE "catalog_categories" ADD COLUMN IF NOT EXISTS "tag" text;
