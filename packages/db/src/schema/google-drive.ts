import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// One row per user who has opted into Drive export. Separate from
// oauth_accounts (login identity) on purpose — this is a revocable,
// opt-in credential grant, not part of how the user signs in. See
// docs/superpowers/specs/2026-08-21-google-drive-export-design.md.
export const googleDriveConnections = pgTable(
  'google_drive_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    googleEmail: text('google_email').notNull(),
    // AES-256-GCM via lib/crypto.ts, keyed by GOOGLE_DRIVE_TOKEN_ENC_KEY.
    // Null once revoked/disconnected — the row is kept (not deleted) so the
    // status endpoint can still say *which* Google account needs reconnecting.
    refreshTokenEnc: text('refresh_token_enc'),
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('google_drive_connections_user_id_uniq').on(t.userId)],
);
