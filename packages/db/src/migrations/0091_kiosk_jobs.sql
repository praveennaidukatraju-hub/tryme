ALTER TABLE "jobs" ADD COLUMN "kiosk_device_id" uuid;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_kiosk_device_id_kiosk_devices_id_fk"
  FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE set null;
--> statement-breakpoint
CREATE TABLE "kiosk_result_likes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "widget_client_id" uuid NOT NULL,
  "kiosk_device_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kiosk_result_likes_job_id_jobs_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE cascade,
  CONSTRAINT "kiosk_result_likes_widget_client_id_widget_clients_id_fk"
    FOREIGN KEY ("widget_client_id") REFERENCES "widget_clients"("id") ON DELETE cascade,
  CONSTRAINT "kiosk_result_likes_kiosk_device_id_kiosk_devices_id_fk"
    FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE set null,
  CONSTRAINT "kiosk_result_likes_job_widget_unique"
    UNIQUE ("job_id", "widget_client_id")
);
--> statement-breakpoint
CREATE TABLE "kiosk_result_cart_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "widget_client_id" uuid NOT NULL,
  "kiosk_device_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kiosk_result_cart_items_job_id_jobs_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE cascade,
  CONSTRAINT "kiosk_result_cart_items_widget_client_id_widget_clients_id_fk"
    FOREIGN KEY ("widget_client_id") REFERENCES "widget_clients"("id") ON DELETE cascade,
  CONSTRAINT "kiosk_result_cart_items_kiosk_device_id_kiosk_devices_id_fk"
    FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE set null,
  CONSTRAINT "kiosk_result_cart_items_job_widget_unique"
    UNIQUE ("job_id", "widget_client_id")
);