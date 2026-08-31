CREATE TABLE "workers" (
  "id"         text PRIMARY KEY,
  "label"      text NOT NULL DEFAULT '',
  "url"        text NOT NULL,
  "api_key"    text NOT NULL,
  "is_active"  boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
