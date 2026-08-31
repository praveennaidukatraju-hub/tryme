import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workflowTemplates } from './models.js';

// Single-row global settings for the saree try-on feature.
// Mirrors tryon_settings — only one row ever exists, upsert with fixed id
// '00000000-0000-0000-0000-000000000001'.
export const sareeSettings = pgTable('saree_settings', {
  id: uuid('id').primaryKey().default(sql`'00000000-0000-0000-0000-000000000001'::uuid`),
  modelImageKey: text('model_image_key'),
  modelImageThumbKey: text('model_image_thumb_key'),
  sampleSareeImageKey: text('sample_saree_image_key'),
  sampleSareeImageThumbKey: text('sample_saree_image_thumb_key'),
  workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplates.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
