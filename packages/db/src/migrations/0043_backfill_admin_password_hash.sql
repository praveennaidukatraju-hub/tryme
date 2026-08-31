UPDATE "admin_users" au
SET "password_hash" = u."password_hash"
FROM "users" u
WHERE au."user_id" = u."id"
  AND au."password_hash" IS NULL
  AND au."status" = 'active';
