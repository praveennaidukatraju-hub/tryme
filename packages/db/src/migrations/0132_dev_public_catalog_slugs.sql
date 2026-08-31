-- Public developer-API asset exposure.
--
-- `public_api_slug` is BOTH the curation flag and the public identifier:
--   NULL     = asset is not reachable from /v1/dev/* at all
--   non-NULL = asset is exposed to third-party API callers under this slug
-- One column instead of a separate boolean + slug pair, so the two can never
-- drift out of sync (exposed-but-unnamed, or named-but-hidden).
--
-- Slugs are deliberately decoupled from every existing internal identifier:
-- garment_subcategories already has a non-unique per-gender `slug` used by
-- Studio, and reusing it would let an internal rename silently break a
-- third-party integration. Same reasoning as dev_tryon_categories.
--
-- No backfill: every asset starts unexposed. An admin opts each one in.

ALTER TABLE "model_faces" ADD COLUMN IF NOT EXISTS "public_api_slug" text;--> statement-breakpoint
ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "public_api_slug" text;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "public_api_slug" text;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "public_api_slug" text;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN IF NOT EXISTS "public_api_slug" text;--> statement-breakpoint

-- Partial unique indexes: uniqueness applies only among EXPOSED assets, so the
-- large majority of rows (NULL) are unconstrained and cost nothing to index.
CREATE UNIQUE INDEX IF NOT EXISTS "model_faces_public_api_slug_key"
  ON "model_faces" ("public_api_slug") WHERE "public_api_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_backgrounds_public_api_slug_key"
  ON "model_backgrounds" ("public_api_slug") WHERE "public_api_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_pose_assets_public_api_slug_key"
  ON "model_pose_assets" ("public_api_slug") WHERE "public_api_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_items_public_api_slug_key"
  ON "catalog_items" ("public_api_slug") WHERE "public_api_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "garment_subcategories_public_api_slug_key"
  ON "garment_subcategories" ("public_api_slug") WHERE "public_api_slug" IS NOT NULL;
