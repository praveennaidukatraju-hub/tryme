CREATE TABLE "background_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "model_backgrounds"
  ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "background_locations"("id"),
  ADD COLUMN IF NOT EXISTS "angle_label" text;

CREATE INDEX IF NOT EXISTS "backgrounds_location_id_idx" ON "model_backgrounds" ("location_id");
