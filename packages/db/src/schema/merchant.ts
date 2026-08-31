import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { garmentSubcategories } from './models.js';
import { users } from './users.js';

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyName: text('company_name').notNull(),
  contactName: text('contact_name').notNull(),
  phone: text('phone').notNull(),
  businessAddress: text('business_address').notNull(),
  isActive: boolean('is_active').notNull().default(false),
  demoData: boolean('demo_data').notNull().default(false),
  // Null = use DEFAULT_JOB_RATE_LIMIT_PER_MIN (packages/types/src/rate-limits.ts).
  // Per-merchant override for how many job-creation calls this merchant's API keys
  // may make per minute (combined across all their keys) to /v1/dev/tryon and
  // /v1/dev/saree-mannequin specifically — NOT every /v1/dev/* route (e.g.
  // /v1/dev/catalog/generate is not covered) — see assertMerchantJobRateLimit in
  // apps/api/src/lib/job-rate-limit.ts. Distinct from the flat per-key
  // request-volume limiter already on those routes (rateLimitConfig in
  // apps/api/src/modules/dev/routes.ts), which caps raw request count, not job
  // creation specifically.
  jobRateLimitPerMin: integer('job_rate_limit_per_min'),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  // Nullable -- R2 object key for the merchant's uploaded logo, shown by the
  // Android app (kiosk + mobile, same app, same login) in place of its bundled
  // Tryme default. Null means "no merchant logo, app uses its own default" --
  // see /v1/auth/device-login's logoUrl field in apps/api/src/modules/auth/routes.ts.
  logoKey: text('logo_key'),
  // 'admin'          -- created through POST /admin/merchants (an admin IS the approval)
  // 'android_google' -- self-serve Google signup from the Android app via
  //                    POST /v1/merchant/onboarding. No separate free-credit
  //                    grant: the user already received their signup free trial,
  //                    and merchant spend draws from that same user_credits
  //                    balance, so watch for accounts burning through it via
  //                    GPU abuse.
  signupSource: text('signup_source', { enum: ['admin', 'android_google'] })
    .notNull()
    .default('admin'),
  // Login credentials live on `users` — a merchant IS a user with a merchants
  // profile attached (same pattern as admin_users). One merchant account per user.
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const merchantCatalogSubcategories = pgTable(
  'merchant_catalog_subcategories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    category: text('category').notNull(), // 'men' | 'women' | 'boys' | 'girls'
    name: text('name').notNull(),
    garmentSubcategoryId: uuid('garment_subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id), // admin garment type — drives the try-on workflow; many subcats -> one type
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('merchant_catalog_subcategories_merchant_idx').on(t.merchantId, t.category)],
);

export const merchantPayments = pgTable('merchant_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  planId: text('plan_id').notNull(),
  razorpayOrderId: text('razorpay_order_id').notNull().unique(),
  razorpayPaymentId: text('razorpay_payment_id'),
  razorpaySignature: text('razorpay_signature'),
  basePaise: integer('base_paise').notNull(),
  gstPaise: integer('gst_paise').notNull(),
  totalPaise: integer('total_paise').notNull(),
  credits: integer('credits').notNull(),
  status: text('status').notNull().default('created'), // created | paid | failed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
});

export const merchantCatalogItems = pgTable(
  'merchant_catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => merchantCatalogSubcategories.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    sku: text('sku'),
    actualPricePaise: integer('actual_price_paise').notNull(),
    offerPricePaise: integer('offer_price_paise').notNull(),
    r2Key: text('r2_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    // Second garment image (pallu) for a two-input (body+pallu) saree product uploaded
    // directly via "Catalogue Image" mode — nullable because most catalog items are
    // single-image. Both r2Key (body) and secondR2Key (pallu) are patched directly into
    // ComfyUI at try-on time; see garmentSubcategories.twoInputTryonWorkflowTemplateId.
    secondR2Key: text('second_r2_key'),
    secondThumbnailKey: text('second_thumbnail_key'),
    sourceJobId: uuid('source_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    sourceKind: text('source_kind').notNull().default('uploaded'), // 'uploaded' | 'generated' | 'imported'
    flatSourceKey: text('flat_source_key'), // provenance only for sourceKind='generated' — never sent to ComfyUI
    isActive: boolean('is_active').notNull().default(true),
    moderationStatus: text('moderation_status').notNull().default('approved'),
    moderationNote: text('moderation_note'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('merchant_catalog_items_merchant_idx').on(t.merchantId, t.isActive),
    index('merchant_catalog_items_subcategory_idx').on(t.subcategoryId),
    uniqueIndex('merchant_catalog_items_merchant_source_job_unique')
      .on(t.merchantId, t.sourceJobId)
      .where(sql`${t.sourceJobId} is not null`),
  ],
);
