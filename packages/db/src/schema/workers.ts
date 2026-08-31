import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  label: text('label').notNull().default(''),
  url: text('url').notNull(),
  apiKey: text('api_key').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  allowedJobTypes: text('allowed_job_types').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
