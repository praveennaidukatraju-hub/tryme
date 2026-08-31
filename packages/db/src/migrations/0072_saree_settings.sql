CREATE TABLE "saree_settings" (
  "id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
  "model_image_key" text,
  "model_image_thumb_key" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
