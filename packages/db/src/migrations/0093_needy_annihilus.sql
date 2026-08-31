CREATE TABLE IF NOT EXISTS "contact_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"source" text,
	"message" text,
	"attachment_key" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kiosk_devices" (
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kiosk_result_cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"widget_client_id" uuid NOT NULL,
	"kiosk_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_result_cart_items_job_widget_unique" UNIQUE("job_id","widget_client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kiosk_result_likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"widget_client_id" uuid NOT NULL,
	"kiosk_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_result_likes_job_widget_unique" UNIQUE("job_id","widget_client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pose_garment_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pose_asset_id" uuid NOT NULL,
	"subcategory_id" uuid NOT NULL,
	"workflow_template_id" uuid,
	"prompt_garment_phase" text,
	"prompt_face_phase" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pose_garment_configs_pose_subcat_unique" UNIQUE("pose_asset_id","subcategory_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saree_settings" (
	"id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
	"model_image_key" text,
	"model_image_thumb_key" text,
	"sample_saree_image_key" text,
	"sample_saree_image_thumb_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tryon_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"workflow_template_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tryon_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tryon_category_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"thumbnail_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tryon_settings" (
	"id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
	"person_sample_key" text,
	"person_sample_thumb_key" text,
	"garment_sample_key" text,
	"garment_sample_thumb_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_catalog_items" (
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_client_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"razorpay_order_id" text NOT NULL,
	"razorpay_payment_id" text,
	"razorpay_signature" text,
	"base_paise" integer NOT NULL,
	"gst_paise" integer NOT NULL,
	"total_paise" integer NOT NULL,
	"credits" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "merchant_payments_razorpay_order_id_unique" UNIQUE("razorpay_order_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_client_credits" (
	"widget_client_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"website_url" text NOT NULL,
	"company_size" text NOT NULL,
	"purpose" text NOT NULL,
	"business_address" text NOT NULL,
	"password_hash" text NOT NULL,
	"widget_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"kiosk_enabled" boolean DEFAULT false NOT NULL,
	"max_kiosk_devices" integer DEFAULT 5 NOT NULL,
	"allowed_origins" text[] DEFAULT '{}' NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"user_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_clients_email_unique" UNIQUE("email"),
	CONSTRAINT "widget_clients_widget_key_unique" UNIQUE("widget_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_client_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"job_id" uuid,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"api_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"allowed_job_types" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS "model_poses" CASCADE;--> statement-breakpoint
ALTER TABLE "job_inputs" DROP CONSTRAINT IF EXISTS "job_inputs_pose_id_model_poses_id_fk";
--> statement-breakpoint
ALTER TABLE "model_pose_assets" DROP CONSTRAINT IF EXISTS "model_pose_assets_face_id_model_faces_id_fk";
--> statement-breakpoint
ALTER TABLE "model_pose_assets" DROP CONSTRAINT IF EXISTS "model_pose_assets_background_id_model_backgrounds_id_fk";
--> statement-breakpoint
ALTER TABLE "job_inputs" ALTER COLUMN "face_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job_inputs" ALTER COLUMN "background_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job_inputs" ALTER COLUMN "pose_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tier" SET DEFAULT 'free';--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN IF NOT EXISTS "preferences" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "credit_plans" ADD COLUMN IF NOT EXISTS "queue_stream" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_plans" ADD COLUMN IF NOT EXISTS "watermark" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_inputs" ADD COLUMN IF NOT EXISTS "garment_type_id" uuid;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN IF NOT EXISTS "asset_kind" text DEFAULT 'ORIGINAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN IF NOT EXISTS "watermark_version" smallint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "queue_stream" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "watermark" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "parent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "widget_client_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "kiosk_device_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "customer_photo_key" text;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN IF NOT EXISTS "tryon_category_id" uuid;--> statement-breakpoint
ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "bg_comfy_r2_key" text;--> statement-breakpoint
ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "category_id" integer;--> statement-breakpoint
ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "model_backgrounds" ADD COLUMN IF NOT EXISTS "special_tag" text;--> statement-breakpoint
ALTER TABLE "model_faces" ADD COLUMN IF NOT EXISTS "face_side_r2_key" text;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "prompt_face_phase" text;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pose_assets" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "latent_size_node_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "latent_max_px" integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "output_size_node_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "output_max_px" integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "result_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "workflow_type" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "widget_garment_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "widget_customer_photo_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "widget_output_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "tryon_person_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "tryon_garment_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN IF NOT EXISTS "tryon_output_node_id" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "kiosk_device_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "widget_client_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "device_id" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "device_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "max_active_devices" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_result_cart_items" ADD CONSTRAINT "kiosk_result_cart_items_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_result_cart_items" ADD CONSTRAINT "kiosk_result_cart_items_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_result_cart_items" ADD CONSTRAINT "kiosk_result_cart_items_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_result_likes" ADD CONSTRAINT "kiosk_result_likes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_result_likes" ADD CONSTRAINT "kiosk_result_likes_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kiosk_result_likes" ADD CONSTRAINT "kiosk_result_likes_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pose_garment_configs" ADD CONSTRAINT "pose_garment_configs_pose_asset_id_model_pose_assets_id_fk" FOREIGN KEY ("pose_asset_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pose_garment_configs" ADD CONSTRAINT "pose_garment_configs_subcategory_id_garment_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pose_garment_configs" ADD CONSTRAINT "pose_garment_configs_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tryon_categories" ADD CONSTRAINT "tryon_categories_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tryon_category_samples" ADD CONSTRAINT "tryon_category_samples_category_id_tryon_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."tryon_categories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_catalog_items" ADD CONSTRAINT "merchant_catalog_items_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_catalog_items" ADD CONSTRAINT "merchant_catalog_items_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_payments" ADD CONSTRAINT "merchant_payments_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "widget_client_credits" ADD CONSTRAINT "widget_client_credits_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "widget_clients" ADD CONSTRAINT "widget_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "widget_credit_ledger" ADD CONSTRAINT "widget_credit_ledger_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pose_garment_configs_pose_asset_id_idx" ON "pose_garment_configs" USING btree ("pose_asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pose_garment_configs_subcategory_id_idx" ON "pose_garment_configs" USING btree ("subcategory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_catalog_items_widget_client_idx" ON "merchant_catalog_items" USING btree ("widget_client_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_catalog_items_widget_client_source_job_unique" ON "merchant_catalog_items" USING btree ("widget_client_id","source_job_id") WHERE "merchant_catalog_items"."source_job_id" is not null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_pose_id_model_pose_assets_id_fk" FOREIGN KEY ("pose_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_garment_type_id_garment_subcategories_id_fk" FOREIGN KEY ("garment_type_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_backgrounds" ADD CONSTRAINT "model_backgrounds_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_widget_client_id_widget_clients_id_fk" FOREIGN KEY ("widget_client_id") REFERENCES "public"."widget_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "face_side_r2_key";--> statement-breakpoint
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "bg_comfy_r2_key";--> statement-breakpoint
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "face_id";--> statement-breakpoint
ALTER TABLE "model_pose_assets" DROP COLUMN IF EXISTS "background_id";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_exactly_one_owner" CHECK (num_nonnulls(user_id, kiosk_device_id, widget_client_id) = 1);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;