import { pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { merchants } from './merchant.js';

// Like/cart toggles on a merchant tryon result — named kiosk* from an earlier
// in-store kiosk feature that has since been removed, but the tables are live:
// PUT/DELETE /v1/merchant/tryon/jobs/:jobId/like and .../cart
// (apps/api/src/modules/merchant/tryon-results.routes.ts) still read/write them.
export const kioskResultLikes = pgTable(
  'kiosk_result_likes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique('kiosk_result_likes_job_merchant_unique').on(t.jobId, t.merchantId),
  }),
);

export const kioskResultCartItems = pgTable(
  'kiosk_result_cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique('kiosk_result_cart_items_job_merchant_unique').on(t.jobId, t.merchantId),
  }),
);
