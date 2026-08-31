ALTER TABLE "merchants"
ADD COLUMN "signup_source" text NOT NULL DEFAULT 'admin'
CONSTRAINT "merchants_signup_source_check"
CHECK ("signup_source" IN ('admin', 'android_google'));
