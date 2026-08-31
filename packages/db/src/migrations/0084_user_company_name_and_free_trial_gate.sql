ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "company_name" text;
--> statement-breakpoint
WITH keepers AS (
  SELECT DISTINCT ON ("user_id") ctid
  FROM "credit_ledger"
  WHERE "reason" = 'FREE_TRIAL'
  ORDER BY "user_id", "created_at"
)
DELETE FROM "credit_ledger"
WHERE "reason" = 'FREE_TRIAL'
  AND ctid NOT IN (SELECT ctid FROM keepers);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_free_trial_user_uniq"
  ON "credit_ledger" ("user_id")
  WHERE "reason" = 'FREE_TRIAL';
