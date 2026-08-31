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
import { merchants } from './merchant.js';
import { garmentSubcategories } from './models.js';
import { users } from './users.js';

/**
 * Admin-authored demo catalogue content, shown on merchant devices without the
 * merchant owning or being able to edit it. Deliberately NOT merchant_catalog_*
 * rows with a flag: these have no merchantId at all, so no merchant query can
 * ever accidentally treat them as its own, and one R2 object serves every
 * assigned merchant instead of N copies.
 */
export const demoCatalogSets = pgTable('demo_catalog_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const demoCatalogSubcategories = pgTable(
  'demo_catalog_subcategories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => demoCatalogSets.id, { onDelete: 'cascade' }),
    category: text('category').notNull(), // 'men' | 'women' | 'boys' | 'girls'
    name: text('name').notNull(),
    // Drives the try-on workflow, exactly as it does for merchant subcategories:
    // garment_subcategories.tryonCategoryId -> tryon_categories.workflowTemplateId.
    garmentSubcategoryId: uuid('garment_subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demo_catalog_subcategories_set_idx').on(t.setId, t.category)],
);

export const demoCatalogItems = pgTable(
  'demo_catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => demoCatalogSubcategories.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    sku: text('sku'),
    actualPricePaise: integer('actual_price_paise').notNull().default(0),
    offerPricePaise: integer('offer_price_paise').notNull().default(0),
    r2Key: text('r2_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demo_catalog_items_subcategory_idx').on(t.subcategoryId, t.isActive)],
);

/** The only thing that makes a demo set visible to a merchant. */
export const demoCatalogAssignments = pgTable(
  'demo_catalog_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => demoCatalogSets.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('demo_catalog_assignments_set_merchant_unique').on(t.setId, t.merchantId),
    index('demo_catalog_assignments_merchant_idx').on(t.merchantId),
  ],
);
