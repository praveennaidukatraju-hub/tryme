CREATE TABLE "widget_clients" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_name"     text NOT NULL,
  "contact_name"     text NOT NULL,
  "email"            text NOT NULL UNIQUE,
  "phone"            text NOT NULL,
  "website_url"      text NOT NULL,
  "company_size"     text NOT NULL,
  "purpose"          text NOT NULL,
  "business_address" text NOT NULL,
  "password_hash"    text NOT NULL,
  "widget_key"       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  "is_active"        boolean NOT NULL DEFAULT true,
  "allowed_origins"  text[] NOT NULL DEFAULT '{}',
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "widget_client_credits" (
  "widget_client_id" uuid PRIMARY KEY REFERENCES "widget_clients"("id") ON DELETE CASCADE,
  "balance"          integer NOT NULL DEFAULT 0,
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "widget_credit_ledger" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "widget_client_id" uuid NOT NULL REFERENCES "widget_clients"("id") ON DELETE CASCADE,
  "delta"            integer NOT NULL,
  "reason"           text NOT NULL,
  "job_id"           uuid,
  "admin_id"         uuid,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "jobs"
  ALTER COLUMN "user_id" DROP NOT NULL,
  ADD COLUMN "widget_client_id"    uuid REFERENCES "widget_clients"("id") ON DELETE SET NULL,
  ADD COLUMN "customer_photo_key"  text;

ALTER TABLE "job_inputs"
  ALTER COLUMN "face_id" DROP NOT NULL,
  ALTER COLUMN "background_id" DROP NOT NULL,
  ALTER COLUMN "pose_id" DROP NOT NULL;
