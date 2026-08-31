ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Mark all pre-existing accounts as verified (registered before this feature existed)
UPDATE users SET email_verified = true WHERE email_verified = false;
