ALTER TABLE "shopify_stores" ADD COLUMN "plan_handle" text;
ALTER TABLE "shopify_stores" ADD COLUMN "subscription_status" text;
ALTER TABLE "shopify_stores" ADD COLUMN "current_billing_cycle_start" timestamptz;
ALTER TABLE "shopify_stores" ADD COLUMN "last_billing_sync_at" timestamptz;

ALTER TABLE "credit_ledger" ADD COLUMN "external_ref" text;

CREATE UNIQUE INDEX "credit_ledger_external_ref_uniq"
  ON "credit_ledger" ("external_ref")
  WHERE "external_ref" IS NOT NULL;
