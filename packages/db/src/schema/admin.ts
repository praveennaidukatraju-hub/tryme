import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('SUPPORT'), // SUPER_ADMIN | MODERATOR | SUPPORT | ADMIN
  status: text('status').notNull().default('active'), // pending | active | rejected
  passwordHash: text('password_hash'), // copied from users.passwordHash at approval time
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  preferences: jsonb('preferences').$type<{ theme?: 'light' | 'dark' | 'system' }>().default({}),
});
