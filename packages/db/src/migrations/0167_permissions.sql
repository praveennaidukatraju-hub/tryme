ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_check"
  CHECK ("role" IN ('SUPER_ADMIN','ADMIN','MODERATOR','SUPPORT'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL UNIQUE,
	"description" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"permission_id" uuid NOT NULL REFERENCES "permissions"("id") ON DELETE cascade,
	CONSTRAINT "role_permissions_role_permission_id_unique" UNIQUE("role", "permission_id")
);
--> statement-breakpoint
INSERT INTO "permissions" ("key", "description") VALUES
  ('admin.me', 'Access current admin profile and permissions'),
  ('catalog.read', 'View catalog items'),
  ('catalog.write', 'Create and update catalog items'),
  ('catalog.delete', 'Delete catalog items'),
  ('catalogue_templates.read', 'View catalogue templates'),
  ('catalogue_templates.write', 'Create and update catalogue templates'),
  ('catalogue_templates.delete', 'Delete catalogue templates'),
  ('subcategories.read', 'View subcategories and garment types'),
  ('subcategories.write', 'Create and update subcategories'),
  ('subcategories.delete', 'Delete subcategories'),
  ('assets.read', 'View models, faces, backgrounds, poses'),
  ('assets.write', 'Create and update asset images and poses'),
  ('assets.delete', 'Delete asset images and poses'),
  ('demo_catalog.read', 'View demo catalog items'),
  ('demo_catalog.write', 'Create and update demo catalog items'),
  ('demo_catalog.delete', 'Delete demo catalog items'),
  ('merchant_catalog.manage', 'View and manage merchant catalog items'),
  ('merchants.read', 'List and search merchants'),
  ('merchants.manage', 'Update merchant details'),
  ('merchants.write', 'Create, delete merchants and set limits'),
  ('workers.read', 'List workers and job types'),
  ('workers.drain', 'Drain and undrain GPU workers'),
  ('workers.write', 'Create, update, and delete GPU workers'),
  ('workflows.read', 'List and view workflow templates'),
  ('workflows.write', 'Create, update, reassign, and delete workflow templates'),
  ('saree.read', 'View saree configurations and templates'),
  ('saree.write', 'Create and update saree configurations'),
  ('tryon.read', 'View tryon workflows and configurations'),
  ('tryon.write', 'Create and update tryon workflows'),
  ('dev_api.read', 'View developer API keys and usage'),
  ('dev_api.write', 'Manage developer API configuration'),
  ('jobs.read', 'View jobs and job details'),
  ('jobs.write', 'Retry, cancel, and modify jobs'),
  ('held_jobs.manage', 'Release and reject held jobs'),
  ('credits.read', 'View credit ledger and credit stats'),
  ('credits.write', 'Grant and deduct user credits'),
  ('credit_plans.write', 'Update credit plans and pricing'),
  ('credit_analysis.read', 'View credit usage and analysis'),
  ('signup_campaigns.write', 'Create and manage signup campaigns'),
  ('shopify_funnels.write', 'Manage Shopify funnel templates'),
  ('shopify_stores.read', 'View connected Shopify stores'),
  ('chatbot.read', 'Monitor chatbot conversations'),
  ('chatbot.manage', 'Manage chatbot knowledge base and QnA'),
  ('contact.read', 'View contact messages'),
  ('contact.write', 'Reply to and update contact messages'),
  ('config.read', 'View system configuration'),
  ('config.manage', 'Update operational system configuration'),
  ('config.write', 'Update critical system configuration'),
  ('telemetry.read', 'View system telemetry'),
  ('users.read', 'List users and view user profiles'),
  ('users.write', 'Create users, reset passwords, and update users'),
  ('users.delete', 'Delete and erase users'),
  ('admin_users.manage', 'Approve, reject, invite, and manage admin users'),
  ('audit.read', 'View admin audit activity trail')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role", "permission_id")
SELECT 'SUPER_ADMIN', "id" FROM "permissions"
ON CONFLICT ("role", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role", "permission_id")
SELECT 'ADMIN', "id" FROM "permissions"
WHERE "key" IN (
  'admin.me', 'catalog.read', 'catalog.write',
  'catalogue_templates.read', 'catalogue_templates.write',
  'subcategories.read', 'subcategories.write',
  'assets.read', 'assets.write',
  'demo_catalog.read', 'demo_catalog.write',
  'merchant_catalog.manage', 'merchants.read', 'merchants.manage',
  'workers.read', 'workers.drain',
  'workflows.read',
  'saree.read', 'tryon.read', 'dev_api.read',
  'jobs.read', 'jobs.write', 'held_jobs.manage',
  'credits.read', 'credits.write', 'credit_analysis.read',
  'shopify_funnels.write', 'shopify_stores.read',
  'chatbot.read', 'chatbot.manage',
  'contact.read', 'contact.write',
  'config.read', 'config.manage',
  'telemetry.read',
  'users.read', 'users.write'
)
ON CONFLICT ("role", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role", "permission_id")
SELECT 'MODERATOR', "id" FROM "permissions"
WHERE "key" IN (
  'admin.me', 'catalog.read', 'catalog.write', 'catalog.delete',
  'catalogue_templates.read', 'catalogue_templates.write', 'catalogue_templates.delete',
  'subcategories.read', 'subcategories.write', 'subcategories.delete',
  'assets.read', 'assets.write', 'assets.delete',
  'demo_catalog.read', 'demo_catalog.write', 'demo_catalog.delete',
  'workers.read', 'workers.drain',
  'workflows.read', 'workflows.write',
  'saree.read', 'saree.write',
  'tryon.read', 'tryon.write',
  'dev_api.read', 'dev_api.write',
  'jobs.read', 'jobs.write',
  'credits.read', 'credits.write', 'credit_analysis.read',
  'shopify_funnels.write',
  'chatbot.read',
  'contact.read', 'contact.write',
  'config.read', 'config.manage',
  'telemetry.read',
  'users.read', 'users.write'
)
ON CONFLICT ("role", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role", "permission_id")
SELECT 'SUPPORT', "id" FROM "permissions"
WHERE "key" IN (
  'admin.me',
  'workers.read',
  'jobs.read',
  'credits.read', 'credit_analysis.read',
  'shopify_stores.read',
  'chatbot.read',
  'contact.read',
  'config.read',
  'users.read'
)
ON CONFLICT ("role", "permission_id") DO NOTHING;
