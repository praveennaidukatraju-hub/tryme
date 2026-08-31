import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const contactRequests = pgTable('contact_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  source: text('source'),
  message: text('message'),
  attachmentKey: text('attachment_key'),
  status: text('status').notNull().default('new'), // new | read | done
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
