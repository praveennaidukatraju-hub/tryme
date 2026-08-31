ALTER TABLE "widget_clients" RENAME TO "merchants";--> statement-breakpoint
ALTER TABLE "widget_client_credits" RENAME TO "merchant_credits";--> statement-breakpoint
ALTER TABLE "widget_credit_ledger" RENAME TO "merchant_credit_ledger";--> statement-breakpoint

ALTER TABLE "merchant_credits" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "merchant_credit_ledger" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "merchant_payments" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "kiosk_devices" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "kiosk_result_likes" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "kiosk_result_cart_items" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint
ALTER TABLE "refresh_tokens" RENAME COLUMN "widget_client_id" TO "merchant_id";--> statement-breakpoint

ALTER TABLE "merchants" RENAME CONSTRAINT "widget_clients_pkey" TO "merchants_pkey";--> statement-breakpoint
ALTER TABLE "merchants" RENAME CONSTRAINT "widget_clients_user_id_users_id_fk" TO "merchants_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "merchants" RENAME CONSTRAINT "widget_clients_user_id_unique" TO "merchants_user_id_unique";--> statement-breakpoint
ALTER TABLE "merchants" RENAME CONSTRAINT "widget_clients_widget_key_key" TO "merchants_widget_key_key";--> statement-breakpoint

ALTER TABLE "merchant_credits" RENAME CONSTRAINT "widget_client_credits_pkey" TO "merchant_credits_pkey";--> statement-breakpoint
ALTER TABLE "merchant_credits" RENAME CONSTRAINT "widget_client_credits_widget_client_id_fkey" TO "merchant_credits_merchant_id_fkey";--> statement-breakpoint
ALTER TABLE "merchant_credits" RENAME CONSTRAINT "widget_client_credits_widget_client_id_widget_clients_id_fk" TO "merchant_credits_merchant_id_merchants_id_fk";--> statement-breakpoint

ALTER TABLE "merchant_credit_ledger" RENAME CONSTRAINT "widget_credit_ledger_pkey" TO "merchant_credit_ledger_pkey";--> statement-breakpoint
ALTER TABLE "merchant_credit_ledger" RENAME CONSTRAINT "widget_credit_ledger_widget_client_id_fkey" TO "merchant_credit_ledger_merchant_id_fkey";--> statement-breakpoint
ALTER TABLE "merchant_credit_ledger" RENAME CONSTRAINT "widget_credit_ledger_widget_client_id_widget_clients_id_fk" TO "merchant_credit_ledger_merchant_id_merchants_id_fk";--> statement-breakpoint

ALTER TABLE "merchant_payments" RENAME CONSTRAINT "merchant_payments_widget_client_id_fkey" TO "merchant_payments_merchant_id_fkey";--> statement-breakpoint
ALTER TABLE "merchant_payments" RENAME CONSTRAINT "merchant_payments_widget_client_id_widget_clients_id_fk" TO "merchant_payments_merchant_id_merchants_id_fk";--> statement-breakpoint

ALTER TABLE "merchant_catalog_items" RENAME CONSTRAINT "merchant_catalog_items_widget_client_id_widget_clients_id_fk" TO "merchant_catalog_items_merchant_id_merchants_id_fk";--> statement-breakpoint
ALTER INDEX "merchant_catalog_items_widget_client_idx" RENAME TO "merchant_catalog_items_merchant_idx";--> statement-breakpoint
ALTER INDEX "merchant_catalog_items_widget_client_source_job_unique" RENAME TO "merchant_catalog_items_merchant_source_job_unique";--> statement-breakpoint

ALTER TABLE "kiosk_devices" RENAME CONSTRAINT "kiosk_devices_widget_client_id_widget_clients_id_fk" TO "kiosk_devices_merchant_id_merchants_id_fk";--> statement-breakpoint

ALTER TABLE "kiosk_result_likes" RENAME CONSTRAINT "kiosk_result_likes_widget_client_id_widget_clients_id_fk" TO "kiosk_result_likes_merchant_id_merchants_id_fk";--> statement-breakpoint
ALTER TABLE "kiosk_result_likes" RENAME CONSTRAINT "kiosk_result_likes_job_widget_unique" TO "kiosk_result_likes_job_merchant_unique";--> statement-breakpoint

ALTER TABLE "kiosk_result_cart_items" RENAME CONSTRAINT "kiosk_result_cart_items_widget_client_id_widget_clients_id_fk" TO "kiosk_result_cart_items_merchant_id_merchants_id_fk";--> statement-breakpoint
ALTER TABLE "kiosk_result_cart_items" RENAME CONSTRAINT "kiosk_result_cart_items_job_widget_unique" TO "kiosk_result_cart_items_job_merchant_unique";--> statement-breakpoint

ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_widget_client_id_fkey" TO "jobs_merchant_id_fkey";--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_widget_client_id_widget_clients_id_fk" TO "jobs_merchant_id_merchants_id_fk";--> statement-breakpoint

ALTER TABLE "refresh_tokens" RENAME CONSTRAINT "refresh_tokens_widget_client_id_widget_clients_id_fk" TO "refresh_tokens_merchant_id_merchants_id_fk";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_exactly_one_owner";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_exactly_one_owner" CHECK (num_nonnulls(user_id, kiosk_device_id, merchant_id) = 1);
