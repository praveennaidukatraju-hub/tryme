import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { merchants } from './merchant.js';

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  // sha256(full key), hex. Unique so auth is a single index probe — and so a DB
  // dump never yields a usable key. The plaintext key exists only in the create
  // response.
  keyHash: text('key_hash').notNull().unique(),
  // e.g. "sk_live_a1b2" — dashboard display only, never sufficient to authenticate.
  keyPrefix: text('key_prefix').notNull(),
  // 'full' can call every /v1/dev/* route; 'widget' is restricted to the
  // storefront-safe allowlist enforced by requireDevScope() in dev-api-auth.ts
  // (plus a handful of routes, like GET /v1/dev/balance, that opt out of the
  // scope check entirely because the data they return isn't sensitive).
  // No CHECK constraint — same deliberate choice as jobs.source (see
  // packages/types/src/job-taxonomy.ts).
  scope: text('scope', { enum: ['full', 'widget'] })
    .notNull()
    .default('full'),
  // Which integration minted this key. Resolved server-side into jobs.source —
  // never trusted from a client-supplied field. See
  // docs/wordpress-plugin-design.md §4.2a.
  integration: text('integration', { enum: ['generic', 'wordpress'] })
    .notNull()
    .default('generic'),
  // The merchant's storefront origin (e.g. "https://myshop.com"), set only for
  // integration='wordpress' widget keys. Checked against the browser's Origin
  // header in server.ts's CORS callback — mirrors shopifyStores.allowedOrigins,
  // but one column not an array since one widget key is expected per site
  // (docs/wordpress-plugin-design.md §4.2). Null for every other key.
  allowedOrigin: text('allowed_origin'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
