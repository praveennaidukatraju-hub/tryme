ALTER TABLE "refresh_tokens"
  ADD COLUMN "family_id" uuid,
  ADD COLUMN "generation" integer NOT NULL DEFAULT 1,
  ADD COLUMN "used_at" timestamp with time zone,
  ADD COLUMN "revoked_at" timestamp with time zone;

UPDATE "refresh_tokens" SET "family_id" = gen_random_uuid() WHERE "family_id" IS NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" SET NOT NULL;

UPDATE "refresh_tokens" SET "revoked_at" = "created_at" WHERE "revoked" = true AND "revoked_at" IS NULL;

DO $$
DECLARE dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "family_id", "generation", COUNT(*) FROM "refresh_tokens"
    GROUP BY "family_id", "generation" HAVING COUNT(*) > 1
  ) AS dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Duplicate (family_id, generation): % rows', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "refresh_tokens_token_hash_unique" ON "refresh_tokens"("token_hash");
CREATE UNIQUE INDEX "refresh_tokens_family_generation_unique" ON "refresh_tokens"("family_id", "generation");
-- Intentionally does not include expires_at.
-- Expired-but-unused generations still occupy the active slot.
-- This forces re-authentication instead of attempting automatic family repair.
CREATE UNIQUE INDEX "refresh_tokens_one_active_per_family" ON "refresh_tokens"("family_id")
  WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
