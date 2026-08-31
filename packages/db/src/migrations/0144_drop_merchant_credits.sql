-- Release 2 of the credit unification. 0143 folded every merchant_credits
-- balance into the owning user's user_credits row and wrote a
-- MERCHANT_CREDITS_MIGRATION ledger entry for each. This migration must not
-- run until that release has deployed and production balances have been
-- reconciled against the backfill -- do not queue this alongside 0143 in the
-- same deploy. The guard below enforces the one part of that precondition a
-- migration can actually check: every merchant with money to lose has
-- already been credited.
--
-- merchant_payments is deliberately retained: merchants keep their own Razorpay
-- checkout and their own MERCHANT_PLAN_BILLING pricing. Only the credit
-- destination moved.

DO $$
DECLARE
  unmigrated_count integer;
BEGIN
  SELECT count(*) INTO unmigrated_count
  FROM "merchant_credits" mc
  JOIN "merchants" m ON m."id" = mc."merchant_id"
  WHERE mc."balance" <> 0
    AND NOT EXISTS (
      SELECT 1 FROM "credit_ledger" cl
      WHERE cl."user_id" = m."user_id"
        AND cl."reason" = 'MERCHANT_CREDITS_MIGRATION'
    );

  IF unmigrated_count > 0 THEN
    RAISE EXCEPTION
      '0144: % merchant_credits row(s) with a non-zero balance have no MERCHANT_CREDITS_MIGRATION ledger entry -- 0143 has not run (or not reconciled) against this database. Refusing to drop merchant_credits.',
      unmigrated_count;
  END IF;
END $$;

DROP TABLE IF EXISTS "merchant_credit_ledger";
DROP TABLE IF EXISTS "merchant_credits";
