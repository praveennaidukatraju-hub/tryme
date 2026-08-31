ALTER TABLE "users" ADD COLUMN "max_active_devices" integer DEFAULT 1 NOT NULL;
ALTER TABLE "refresh_tokens" ADD COLUMN "device_id" text;
ALTER TABLE "refresh_tokens" ADD COLUMN "device_name" text;

CREATE INDEX "refresh_tokens_user_device_active_idx"
  ON "refresh_tokens" ("user_id", "device_id", "portal")
  WHERE "used_at" IS NULL AND "revoked_at" IS NULL AND "device_id" IS NOT NULL;