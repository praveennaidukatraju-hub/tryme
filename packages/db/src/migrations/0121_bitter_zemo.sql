ALTER TABLE "model_backgrounds" ADD COLUMN "user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_backgrounds" ADD CONSTRAINT "model_backgrounds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_backgrounds_user_id_idx" ON "model_backgrounds" USING btree ("user_id") WHERE "model_backgrounds"."user_id" is not null;