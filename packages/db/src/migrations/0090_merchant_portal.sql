ALTER TABLE "widget_clients" ADD COLUMN "kiosk_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "widget_clients" ADD COLUMN "max_kiosk_devices" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE "widget_clients" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "widget_clients" ADD CONSTRAINT "widget_clients_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
CREATE TABLE "merchant_catalog_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "widget_client_id" uuid NOT NULL,
  "label" text NOT NULL,
  "sku" text,
  "gender" text,
  "category" text,
  "r2_key" text NOT NULL,
  "thumbnail_key" text NOT NULL,
  "source_job_id" uuid,
  "is_active" boolean DEFAULT true NOT NULL,
  "moderation_status" text DEFAULT 'approved' NOT NULL,
  "moderation_note" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merchant_catalog_items_widget_client_id_widget_clients_id_fk"
    FOREIGN KEY ("widget_client_id") REFERENCES "widget_clients"("id") ON DELETE cascade,
  CONSTRAINT "merchant_catalog_items_source_job_id_jobs_id_fk"
    FOREIGN KEY ("source_job_id") REFERENCES "jobs"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX "merchant_catalog_items_widget_client_idx"
  ON "merchant_catalog_items" ("widget_client_id", "is_active");
--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_catalog_items_widget_client_source_job_unique"
  ON "merchant_catalog_items" ("widget_client_id", "source_job_id")
  WHERE "source_job_id" IS NOT NULL;