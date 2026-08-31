-- Remove duplicate (job_id, reason) rows before creating the unique index.
-- DISTINCT ON picks one physical row (ctid) per group; the rest are deleted.
WITH keepers AS (
  SELECT DISTINCT ON ("job_id", "reason") ctid
  FROM "credit_ledger"
  WHERE "job_id" IS NOT NULL
  ORDER BY "job_id", "reason"
)
DELETE FROM "credit_ledger"
WHERE "job_id" IS NOT NULL
  AND ctid NOT IN (SELECT ctid FROM keepers);

CREATE UNIQUE INDEX "credit_ledger_job_reason_uniq"
  ON "credit_ledger" ("job_id", "reason")
  WHERE "job_id" IS NOT NULL;
