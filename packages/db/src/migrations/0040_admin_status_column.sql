ALTER TABLE "admin_users" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
