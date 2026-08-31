-- Shopify App Pricing subscription state is read from the Admin GraphQL API's
-- currentAppInstallation.activeSubscriptions, not the Partner API. That shape
-- has no currentBillingCycle.startTime; the cycle is identified by the
-- subscription's own id plus its currentPeriodEnd. 0148's column assumed the
-- Partner API shape and was never populated with anything meaningful.
ALTER TABLE "shopify_stores" DROP COLUMN IF EXISTS "current_billing_cycle_start";
ALTER TABLE "shopify_stores" ADD COLUMN "current_subscription_id" text;
ALTER TABLE "shopify_stores" ADD COLUMN "current_period_end" timestamptz;
