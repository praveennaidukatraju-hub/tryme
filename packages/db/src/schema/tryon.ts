import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workflowTemplates } from './models.js';

export const tryonCategories = pgTable('tryon_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplates.id, {
    onDelete: 'set null',
  }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tryonCategorySamples = pgTable('tryon_category_samples', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => tryonCategories.id, { onDelete: 'cascade' }),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Single-row global settings for the tryon feature.
// Upsert with fixed id = '00000000-0000-0000-0000-000000000001'.
export const tryonSettings = pgTable('tryon_settings', {
  id: uuid('id').primaryKey().default(sql`'00000000-0000-0000-0000-000000000001'::uuid`),
  personSampleKey: text('person_sample_key'),
  personSampleThumbKey: text('person_sample_thumb_key'),
  garmentSampleKey: text('garment_sample_key'),
  garmentSampleThumbKey: text('garment_sample_thumb_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
