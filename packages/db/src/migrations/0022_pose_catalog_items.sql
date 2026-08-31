CREATE TABLE IF NOT EXISTS "pose_catalog_items" (
  "pose_id" uuid NOT NULL REFERENCES "model_poses"("id") ON DELETE CASCADE,
  "catalog_item_id" uuid NOT NULL REFERENCES "catalog_items"("id") ON DELETE CASCADE,
  PRIMARY KEY ("pose_id", "catalog_item_id")
);
