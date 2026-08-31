CREATE TABLE "tryon_settings" (
  "id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
  "person_sample_key" text,
  "person_sample_thumb_key" text,
  "garment_sample_key" text,
  "garment_sample_thumb_key" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
