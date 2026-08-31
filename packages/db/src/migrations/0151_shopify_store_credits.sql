CREATE TABLE "shopify_store_credits" (
  "store_id" uuid PRIMARY KEY NOT NULL,
  "balance" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_store_credits_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "shopify_stores"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "shopify_credit_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "delta" integer NOT NULL,
  "reason" text NOT NULL,
  "job_id" uuid,
  "external_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_credit_ledger_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "shopify_stores"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_credit_ledger_job_reason_idx" ON "shopify_credit_ledger" ("job_id", "reason") WHERE "job_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_credit_ledger_external_ref_idx" ON "shopify_credit_ledger" ("external_ref") WHERE "external_ref" IS NOT NULL;
