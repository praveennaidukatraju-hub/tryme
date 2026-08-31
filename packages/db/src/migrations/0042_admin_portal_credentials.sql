ALTER TABLE "admin_users" ADD COLUMN IF NOT EXISTS "password_hash" text;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "portal" text NOT NULL DEFAULT 'web';
