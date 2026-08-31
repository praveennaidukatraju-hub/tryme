ALTER TABLE "admin_users" ADD COLUMN "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;
