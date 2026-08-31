import { boolean, integer, pgTable, serial, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const catalogTypes = pgTable('catalog_types', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
});

export const catalogCategories = pgTable('catalog_categories', {
  id: serial('id').primaryKey(),
  typeId: integer('type_id')
    .notNull()
    .references(() => catalogTypes.id),
  parentId: integer('parent_id'),
  slug: text('slug').notNull(),
  label: text('label').notNull(),
  genderSlug: text('gender_slug'), // nullable — null means all genders
  thumbnailKey: text('thumbnail_key'), // nullable — optional category thumbnail shown in studio
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

export const catalogItems = pgTable('catalog_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: integer('category_id').references(() => catalogCategories.id),
  type: text('type').notNull(), // 'lower' | 'shoe' — stored directly
  genderSlug: text('gender_slug'), // nullable = all genders
  label: text('label').notNull(),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  // See modelFaces.publicApiSlug in ./models.ts — NULL means this item is not
  // reachable from the public developer API.
  publicApiSlug: text('public_api_slug'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
