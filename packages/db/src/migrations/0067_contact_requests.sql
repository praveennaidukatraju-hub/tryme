CREATE TABLE "contact_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text NOT NULL,
  "message" text,
  "status" text NOT NULL DEFAULT 'new',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
