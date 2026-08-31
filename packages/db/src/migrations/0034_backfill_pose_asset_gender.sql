-- Backfill genderSlug on model_pose_assets from the garment subcategory
-- of their linked model_poses mapping rows (all backfilled rows have NULL genderSlug).
UPDATE "model_pose_assets" pa
SET "gender_slug" = gs."gender_slug"
FROM "model_poses" mp
JOIN "garment_subcategories" gs ON mp."subcategory_id" = gs."id"
WHERE mp."pose_asset_id" = pa."id"
  AND pa."gender_slug" IS NULL
  AND gs."gender_slug" IS NOT NULL;
