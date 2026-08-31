-- Custom SQL migration file, put your code below! --

INSERT INTO "permissions" ("key", "description") VALUES
  ('shopify_stores.delete', 'Delete a Shopify store and all its data (dev/test cleanup)')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- SUPER_ADMIN only: cascades through every shopify_* child table (credits,
-- ledger, shoppers, product garments, jobs.shopifyStoreId set null) with no
-- undo. Not granted to ADMIN/MODERATOR/SUPPORT alongside the existing
-- read-only 'shopify_stores.read'.
INSERT INTO "role_permissions" ("role", "permission_id")
SELECT 'SUPER_ADMIN', "id" FROM "permissions"
WHERE "key" = 'shopify_stores.delete'
ON CONFLICT ("role", "permission_id") DO NOTHING;
