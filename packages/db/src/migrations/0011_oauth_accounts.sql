-- make password_hash nullable (Google-only users have no password)
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- new table for OAuth provider identities
CREATE TABLE IF NOT EXISTS "oauth_accounts" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider"     text NOT NULL,
  "provider_id"  text NOT NULL,
  "email"        text,
  "display_name" text,
  "avatar_url"   text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_accounts_provider_provider_id_unique" UNIQUE ("provider", "provider_id")
);
