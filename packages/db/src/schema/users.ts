import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { signupCampaigns } from './campaigns.js';
import { merchants } from './merchant.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable -- admin-created accounts (see /admin/users) may have no email at
    // creation time and log in via `username` instead. Self-registration and
    // Google OAuth always set this.
    email: text('email').unique(),
    passwordHash: text('password_hash'), // nullable — Google-only users have no password
    displayName: text('display_name'),
    phone: text('phone'), // nullable — user-provided, no format enforcement
    companyName: text('company_name'),
    // Optional — customer-supplied GST registration number, editable via
    // PATCH /v1/me. Pre-fills (but does not sync with) the per-purchase
    // gstin captured on `payments` at checkout.
    gstin: text('gstin'),
    // FK to credit_plans.slug added in migration 0080 (ON DELETE RESTRICT) — not
    // declared via .references() here to avoid a circular import with credits.ts.
    tier: text('tier').notNull().default('free'),
    emailVerified: boolean('email_verified').notNull().default(false),
    isBanned: boolean('is_banned').notNull().default(false),
    maxActiveDevices: integer('max_active_devices').notNull().default(1),
    banReason: text('ban_reason'),
    defaultResolution: text('default_resolution').notNull().default('HD'),
    defaultAspectRatio: text('default_aspect_ratio').notNull().default('1:1'),
    defaultPlatform: text('default_platform').notNull().default('Amazon'),
    // Nullable -- only set by admin-created accounts (see POST /admin/users), as an
    // alternate login identifier alongside email. ALWAYS lowercase (both here and
    // wherever it's written or looked up). Restricted to [a-z0-9_.] so it can never
    // contain '@' -- that's what guarantees `WHERE email = $1 OR username = $1` in
    // findUserByIdentifier() (apps/api/src/modules/auth/routes.ts) can never match
    // two different rows. Do not loosen this charset without re-checking that
    // invariant.
    username: text('username').unique(),
    // Set once at signup (email/password register or Google OAuth new-account
    // branch), never updated afterward â€” see docs/superpowers/specs/2026-08-01-gartex-expo-qr-campaign-design.md Â§3.1.
    signupCampaignId: uuid('signup_campaign_id').references(() => signupCampaigns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'users_username_format',
      sql`${t.username} IS NULL OR ${t.username} ~ '^[a-z0-9_.]{3,32}$'`,
    ),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id').references(() => merchants.id, {
      onDelete: 'cascade',
    }),
    familyId: uuid('family_id').notNull(),
    generation: integer('generation').notNull().default(1),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    portal: text('portal').notNull().default('web'), // 'web' | 'admin' | 'mobile' | 'kiosk'
    deviceId: text('device_id'),
    deviceName: text('device_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('refresh_tokens_exactly_one_owner', sql`num_nonnulls(user_id, merchant_id) = 1`)],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerId: text('provider_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_accounts_provider_provider_id_unique').on(t.provider, t.providerId)],
);
