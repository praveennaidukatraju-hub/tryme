ALTER TABLE "garment_subcategories" ADD COLUMN "default_lower_catalog_id" uuid;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "default_shoe_catalog_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_default_lower_catalog_id_catalog_items_id_fk" FOREIGN KEY ("default_lower_catalog_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_default_shoe_catalog_id_catalog_items_id_fk" FOREIGN KEY ("default_shoe_catalog_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
