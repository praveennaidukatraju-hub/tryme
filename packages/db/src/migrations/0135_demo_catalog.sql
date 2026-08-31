CREATE TABLE "demo_catalog_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "demo_catalog_subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"garment_subcategory_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "demo_catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subcategory_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sku" text,
	"actual_price_paise" integer DEFAULT 0 NOT NULL,
	"offer_price_paise" integer DEFAULT 0 NOT NULL,
	"r2_key" text NOT NULL,
	"thumbnail_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "demo_catalog_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"assigned_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "demo_catalog_sets" ADD CONSTRAINT "demo_catalog_sets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_catalog_subcategories" ADD CONSTRAINT "demo_catalog_subcategories_set_id_demo_catalog_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."demo_catalog_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_catalog_subcategories" ADD CONSTRAINT "demo_catalog_subcategories_garment_subcategory_id_garment_subcategories_id_fk" FOREIGN KEY ("garment_subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_catalog_items" ADD CONSTRAINT "demo_catalog_items_subcategory_id_demo_catalog_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."demo_catalog_subcategories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_catalog_assignments" ADD CONSTRAINT "demo_catalog_assignments_set_id_demo_catalog_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."demo_catalog_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_catalog_assignments" ADD CONSTRAINT "demo_catalog_assignments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_catalog_assignments" ADD CONSTRAINT "demo_catalog_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_catalog_subcategories_set_idx" ON "demo_catalog_subcategories" USING btree ("set_id","category");--> statement-breakpoint
CREATE INDEX "demo_catalog_items_subcategory_idx" ON "demo_catalog_items" USING btree ("subcategory_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_catalog_assignments_set_merchant_unique" ON "demo_catalog_assignments" USING btree ("set_id","merchant_id");--> statement-breakpoint
CREATE INDEX "demo_catalog_assignments_merchant_idx" ON "demo_catalog_assignments" USING btree ("merchant_id");
