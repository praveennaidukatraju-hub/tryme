import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const signupCampaigns = pgTable('signup_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Matches the ?src= query param on the signup link, e.g. 'gartex2026'.
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  // Applied to both the first-purchase bonus and the free signup-credit boost.
  bonusPercent: integer('bonus_percent').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
