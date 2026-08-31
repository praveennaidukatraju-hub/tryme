-- merchant_catalog_items currently holds only test/seed data from this session's
-- development — truncate rather than backfill so the new NOT NULL columns
-- (subcategory_id, actual_price_paise, offer_price_paise) can be added directly.
TRUNCATE TABLE "merchant_catalog_items";--> statement-breakpoint

CREATE TABLE "merchant_catalog_subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"garment_subcategory_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "merchant_catalog_subcategories" ADD CONSTRAINT "merchant_catalog_subcategories_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_catalog_subcategories" ADD CONSTRAINT "merchant_catalog_subcategories_garment_subcategory_id_garment_subcategories_id_fk" FOREIGN KEY ("garment_subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_catalog_subcategories_merchant_idx" ON "merchant_catalog_subcategories" USING btree ("merchant_id","category");--> statement-breakpoint

ALTER TABLE "garment_subcategories" ADD COLUMN "default_pose_id" uuid;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_default_pose_id_model_pose_assets_id_fk" FOREIGN KEY ("default_pose_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "merchant_catalog_items" DROP COLUMN "gender";--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "subcategory_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "actual_price_paise" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "offer_price_paise" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "source_kind" text DEFAULT 'uploaded' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "flat_source_key" text;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD CONSTRAINT "merchant_catalog_items_subcategory_id_merchant_catalog_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."merchant_catalog_subcategories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_catalog_items_subcategory_idx" ON "merchant_catalog_items" USING btree ("subcategory_id");
