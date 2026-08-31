ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "gender_slug" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "gender_slug" text;
