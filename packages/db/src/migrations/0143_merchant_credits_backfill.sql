-- Fold each merchant's separate credit balance into the owning user's personal
-- balance. A merchant is a tag on a user, not a separate financial entity, so
-- from here on kiosk and android-tryon spend draws from user_credits like
-- everything else.
--
-- merchants.user_id is UNIQUE, so there is at most one merchant per user and no
-- aggregation is needed. Balances are added, never replaced -- a merchant who
-- also has a personal balance keeps both.
--
-- Re-runnable: the NOT EXISTS guard keys off the audit ledger row this migration
-- writes, so applying it twice cannot double-credit. That matters because this
-- moves real money and the hand-written journal path has no snapshot to diff
-- against.

INSERT INTO "user_credits" ("user_id", "balance")
SELECT m."user_id", mc."balance"
FROM "merchant_credits" mc
JOIN "merchants" m ON m."id" = mc."merchant_id"
WHERE mc."balance" <> 0
  AND NOT EXISTS (
    SELECT 1 FROM "credit_ledger" cl
    WHERE cl."user_id" = m."user_id"
      AND cl."reason" = 'MERCHANT_CREDITS_MIGRATION'
  )
ON CONFLICT ("user_id") DO UPDATE
  SET "balance" = "user_credits"."balance" + EXCLUDED."balance",
      "updated_at" = now();

INSERT INTO "credit_ledger" ("user_id", "delta", "reason")
SELECT m."user_id", mc."balance", 'MERCHANT_CREDITS_MIGRATION'
FROM "merchant_credits" mc
JOIN "merchants" m ON m."id" = mc."merchant_id"
WHERE mc."balance" <> 0
  AND NOT EXISTS (
    SELECT 1 FROM "credit_ledger" cl
    WHERE cl."user_id" = m."user_id"
      AND cl."reason" = 'MERCHANT_CREDITS_MIGRATION'
  );
