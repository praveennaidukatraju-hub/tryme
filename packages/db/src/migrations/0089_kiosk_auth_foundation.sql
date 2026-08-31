CREATE TABLE "kiosk_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "widget_client_id" uuid NOT NULL,
  "label" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "pairing_code_hash" text,
  "pairing_code_expires_at" timestamp with time zone,
  "android_id" text,
  "app_version" text,
  "last_seen_at" timestamp with time zone,
  "paired_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kiosk_devices_widget_client_id_widget_clients_id_fk"
    FOREIGN KEY ("widget_client_id") REFERENCES "widget_clients"("id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "kiosk_device_id" uuid;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "widget_client_id" uuid;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_kiosk_device_id_kiosk_devices_id_fk"
  FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_widget_client_id_widget_clients_id_fk"
  FOREIGN KEY ("widget_client_id") REFERENCES "widget_clients"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_exactly_one_owner"
  CHECK (num_nonnulls("user_id", "kiosk_device_id", "widget_client_id") = 1);
