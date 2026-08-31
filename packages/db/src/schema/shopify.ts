import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { workflowTemplates } from './models.js';
import { users } from './users.js';
export interface ShopifyStoreLimits {
  /** null = off. Hard ceiling on generations per store-local day. */
  storeDailyCap?: number | null;
  /** null = off. Soft — defeatable by a fresh browser; see the design doc. */
  perShopperCap?: number | null;
  perShopperWindow?: 'day' | 'week' | 'month';
  /** null = never ask. 0 = ask before the first generation. */
  emailAfterNTryOns?: number | null;
}

export interface ShopifyStoreRetention {
  /** null = off, for all three. Days until deletion. */
  shopperPhotoDays?: number | null;
  resultDays?: number | null;
  shopperRecordDays?: number | null;
}

export interface ShopifyWidgetTheme {
  /** Hex (#rrggbb). Drives modal CTA, step dots, choose-photo button, retry. */
  accentColor?: string | null;
}

export interface ShopifyWidgetCopy {
  heading?: string | null;
  subheading?: string | null;
  uploadTitle?: string | null;
  uploadLead?: string | null;
  chooseLabel?: string | null;
  ctaLabel?: string | null;
  legalText?: string | null;
  generatingText?: string | null;
  errorText?: string | null;
}

export interface ShopifyWidgetBehavior {
  addToCart?: boolean;
  addToCartLabel?: string | null;
  share?: boolean;
  shareLabel?: string | null;
}

export interface ShopifyWidgetConfig {
  theme?: ShopifyWidgetTheme;
  copy?: ShopifyWidgetCopy;
  behavior?: ShopifyWidgetBehavior;
}

export interface ShopifyActivationSettings {
  mode: 'global' | 'selective';
}

export interface ShopifyStoreSettings {
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
  emailBonusClaimed?: boolean;
  emailBonusClaimedAt?: string;
  limits?: ShopifyStoreLimits;
  retention?: ShopifyStoreRetention;
  widget?: ShopifyWidgetConfig;
  widgetConfigSynced?: boolean;
  activation?: ShopifyActivationSettings;
}

export interface FunnelRuleCondition {
  field: 'product_type' | 'tags' | 'vendor' | 'collections';
  operator: 'equals' | 'contains';
  value: string;
}

export const shopifyStores = pgTable('shopify_stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeKey: uuid('store_key').notNull().unique().defaultRandom(),
  allowedOrigins: text('allowed_origins').array().notNull().default([]),
  shopDomain: text('shop_domain').notNull().unique(),
  shopifyShopId: bigint('shopify_shop_id', { mode: 'number' }).notNull().unique(),
  accessToken: text('access_token').notNull(), // encrypted: iv:authTag:ciphertext
  // All three are nullable because stores installed before expiring tokens
  // shipped hold a perpetual access token with no refresh half. Null
  // refreshToken is the marker for "legacy, never refresh" — see
  // getValidAccessToken in apps/api/src/modules/shopify/token.ts.
  refreshToken: text('refresh_token'), // encrypted: iv:authTag:ciphertext
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope').notNull(),
  // The store's local timezone, from shop.json at install. Drives day
  // boundaries for the store daily cap — a merchant who sets "200/day" and
  // watches it reset at 05:30 local time will file a bug. Null for rows that
  // predate this column; those fall back to UTC until the next reinstall.
  ianaTimezone: text('iana_timezone'),
  // Whether this is a Shopify partner development store (shop.plan.partnerDevelopment).
  // Shopify bills those in test mode only — no money ever moves — so this
  // decides both halves of the billing test flag: what we send Shopify on a
  // charge, and whether a test charge is allowed to grant credits. App Store
  // reviewers test on exactly such a store, and a grant path that refuses every
  // test charge reads to them as an app that takes payment and delivers
  // nothing. Refreshed on every provision, since a store's plan can change.
  partnerDevelopment: boolean('partner_development').notNull().default(false),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
  settings: jsonb('settings').$type<ShopifyStoreSettings>().notNull().default({}),
  syncCursor: text('sync_cursor'),
  // Auto-refill (phase 3). Written in phase 1's migration so a later phase
  // doesn't have to ALTER a table that already carries rows. Null pack id
  // means auto-refill is off, which is every store today.
  autorefillPackId: text('autorefill_pack_id'),
  autorefillTriggerCredits: integer('autorefill_trigger_credits'),
  autorefillSubscriptionId: text('autorefill_subscription_id'),
  // The AppSubscriptionLineItem GID inside autorefillSubscriptionId. Distinct
  // from the subscription id and NOT derivable from it: appUsageRecordCreate
  // addresses the line item, not the subscription. Captured from the
  // appSubscriptionCreate response so a refill never needs an extra round trip
  // to re-resolve it.
  autorefillLineItemId: text('autorefill_line_item_id'),
  autorefillCappedAmountCents: integer('autorefill_capped_amount_cents'),
  // The cycle's spend so far against that ceiling, as Shopify last reported it.
  // A cache of Shopify's own balanceUsed, refreshed by the hourly sweep — never
  // incremented locally, because Shopify resets it on its own 30-day boundary
  // and a locally-summed figure would drift permanently the first time we
  // missed one. Null until the first refresh, or when the subscription has no
  // usage line item to read it off.
  autorefillBalanceUsedCents: integer('autorefill_balance_used_cents'),
  // When the merchant was last emailed that they are near the ceiling, from
  // Shopify's app_subscriptions/approaching_capped_amount webhook. Shopify may
  // deliver that topic repeatedly across one cycle; this is what keeps it to
  // one email. Cleared whenever the cap is raised or the cycle rolls over, so
  // the next approach warns again.
  autorefillCapWarnedAt: timestamp('autorefill_cap_warned_at', { withTimezone: true }),
  // 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'DECLINED' | 'CAP_REACHED'.
  // CAP_REACHED is ours, not Shopify's: it records that a refill was refused
  // because the cycle's capped amount was exhausted, so the UI can say
  // something specific instead of silently falling back to manual.
  autorefillStatus: text('autorefill_status'),
  // The shop owner's contact email, from shop.email at install. Already
  // fetched by SHOP_DETAILS and previously discarded. This is the only address
  // we can reach a merchant on: owner_user_id is nullable and ON DELETE SET
  // NULL, so it cannot be the basis for a billing notification.
  shopEmail: text('shop_email'),
  // The worst alert level we have already emailed this store about. The
  // scheduler emails only when the current level ranks worse than this, so a
  // merchant sitting at 'warning' for a week gets one email rather than 168.
  // Rewritten on recovery (down to 'ok') unconditionally, so a store that
  // tops up is automatically eligible to be alerted again later — but NOT
  // advanced past a worse level unless a notification was actually sent
  // (e.g. no shop_email on record yet): see runAlertTick in
  // alert-scheduler.ts for why stamping this on a send that never happened
  // would permanently suppress that level for the store.
  lastAlertLevel: text('last_alert_level'),
  lastAlertAt: timestamp('last_alert_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopifyStoreCredits = pgTable('shopify_store_credits', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => shopifyStores.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopifyCreditLedger = pgTable('shopify_credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id')
    .notNull()
    .references(() => shopifyStores.id, { onDelete: 'cascade' }),
  delta: integer('delta').notNull(),
  reason: text('reason').notNull(),
  jobId: uuid('job_id'),
  // Idempotency key for non-job-triggered grants (trial, subscription cycle).
  // Mirrors credit_ledger.external_ref (migration 0148) and the (job_id, reason)
  // partial unique index (migration 0074) — both re-created by hand below since
  // drizzle-kit generate does not express partial unique indexes from pgTable
  // column definitions alone.
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per purchase attempt, on either purchase path. Separate from
 * shopify_credit_ledger because a purchase has state *before* any credits
 * exist — the ledger only ever records grants that already happened.
 *
 * `credits` is snapshotted at INSERT and the grant reads THAT column, never
 * config and never Shopify's response (Shopify knows the price, not the
 * credits). This is load-bearing: pack credits are admin-editable while a
 * purchase can sit unconfirmed indefinitely, so re-reading config at confirm
 * time would let an admin edit silently change what an already-paying merchant
 * receives, with no record of the number they agreed to pay for. The row is
 * that record.
 */
export const shopifyCreditPurchases = pgTable(
  'shopify_credit_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    // The AppPurchaseOneTime GID. Null between our INSERT and the mutation
    // returning — a window in which the row exists but no charge does.
    shopifyChargeId: text('shopify_charge_id'),
    // 'manual' | 'autorefill'. Also decides which credit figure applied.
    source: text('source').notNull().default('manual'),
    packId: text('pack_id').notNull(),
    credits: integer('credits').notNull(),
    priceUsdCents: integer('price_usd_cents').notNull(),
    // 'PENDING' | 'ACTIVE' | 'DECLINED' | 'EXPIRED' | 'FAILED'.
    // FAILED is ours and means the charge was never created at Shopify.
    // Deliberately distinct from DECLINED, which means the merchant saw the
    // charge and said no — conflating them makes the two indistinguishable
    // when reconciling against Shopify payouts later.
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('shopify_credit_purchases_store_idx').on(table.storeId),
  }),
);

export const shopifyFunnelTemplates = pgTable(
  'shopify_funnel_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id),
    isActive: boolean('is_active').notNull().default(true),
    // Exactly one row carries this. It is the workflow every Shopify product
    // resolves unless something more specific claims it — today nothing does,
    // so it is the only routing input. Enforced by the partial unique index
    // below rather than by application code, because two defaults would make
    // resolution non-deterministic rather than merely wrong.
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singleDefault: uniqueIndex('shopify_funnel_templates_single_default_idx')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
  }),
);

export const shopifyFunnelRules = pgTable(
  'shopify_funnel_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    funnelTemplateId: uuid('funnel_template_id')
      .notNull()
      .references(() => shopifyFunnelTemplates.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('manual'),
    conditions: jsonb('conditions').$type<FunnelRuleCondition[]>().notNull().default([]),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.funnelTemplateId),
  }),
);

export const shopifyProductGarments = pgTable(
  'shopify_product_garments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }).notNull(),
    shopifyVariantId: bigint('shopify_variant_id', { mode: 'number' }),
    r2Key: text('r2_key').notNull(),
    title: text('title'),
    status: text('status').notNull().default('processing'), // active|processing|failed|deleted
    failedReason: text('failed_reason'),
    funnelTemplateId: uuid('funnel_template_id').references(() => shopifyFunnelTemplates.id),
    funnelAssignmentSource: text('funnel_assignment_source'),
    productType: text('product_type'),
    tags: text('tags').array(),
    vendor: text('vendor'),
    collections: text('collections').array(),
    enabled: boolean('enabled').notNull().default(false),
    // Exclusion tab, products sub-section. Always wins over `enabled`, over
    // collection-based enablement, and over global mode — see
    // apps/api/src/modules/shopify/activation.ts.
    excluded: boolean('excluded').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyProductId, t.shopifyVariantId),
  }),
);

export const shopifyShoppers = pgTable(
  'shopify_shoppers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    // Anonymous UUID minted by the widget and held in localStorage. This is the
    // ROW identity: one row per browser, never merged. Counting identity is a
    // separate, stronger signal resolved per request — see modules/shopify/shopper.ts.
    clientId: text('client_id').notNull(),
    shopifyCustomerId: bigint('shopify_customer_id', { mode: 'number' }),
    email: text('email'),
    // Explicit marketing opt-in. The email is recorded regardless (it keys the
    // per-shopper cap), but only consented rows are marketable.
    emailConsent: boolean('email_consent').notNull().default(false),
    emailCapturedAt: timestamp('email_captured_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.clientId),
    byEmail: index('shopify_shoppers_store_email_idx').on(t.storeId, t.email),
    byCustomer: index('shopify_shoppers_store_customer_idx').on(t.storeId, t.shopifyCustomerId),
  }),
);

/**
 * Append-only storefront interaction log, the source for the merchant
 * Analytics page.
 *
 * `bigserial`, not `uuid` — a deliberate break from this repo's convention.
 * This is the highest-write-rate table in the system and random UUIDs scatter
 * B-tree inserts across the whole index and fragment it, where a monotonic key
 * appends to one page. Nothing references these rows across services and there
 * is no need for an unguessable id, so the reason the uuid convention exists
 * does not apply.
 *
 * Rows are ADVISORY. No credit decision, limit check, or authorization read
 * may ever consult this table — the client-reported types are forgeable by
 * anyone who can open devtools.
 */
export const shopifyWidgetEvents = pgTable(
  'shopify_widget_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    // Matches shopify_shoppers.client_id — how a funnel step joins to a person.
    // Nullable: widget versions predating shopper identity send none.
    clientId: text('client_id'),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }),
    // Client-reported, forgeable:
    //   button_click | upload | result_view | add_to_cart | share
    // Server-written, unforgeable:
    //   refused_store_cap | refused_shopper_cap | refused_email_gate
    type: text('type').notNull(),
    device: text('device'), // 'mobile' | 'desktop'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStoreTime: index('shopify_widget_events_store_time_idx').on(t.storeId, t.createdAt),
    byStoreTypeTime: index('shopify_widget_events_store_type_time_idx').on(
      t.storeId,
      t.type,
      t.createdAt,
    ),
    byStoreProductTime: index('shopify_widget_events_store_product_time_idx').on(
      t.storeId,
      t.shopifyProductId,
      t.createdAt,
    ),
  }),
);

/**
 * Cached collection metadata — only for collections a merchant has actually
 * selected (enabled or excluded). Never populated for the whole store's
 * collection list; there is no reason to know about a collection nobody
 * picked.
 */
export const shopifyCollections = pgTable(
  'shopify_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId),
  }),
);

/**
 * Collection membership, rebuilt in full for one collection at a time
 * (delete + reinsert that collection's rows) whenever that collection is
 * synced — never diffed, membership sets are small enough not to need it.
 */
export const shopifyCollectionProducts = pgTable(
  'shopify_collection_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }).notNull(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId, t.shopifyProductId),
    byStoreProduct: index('shopify_collection_products_store_product_idx').on(
      t.storeId,
      t.shopifyProductId,
    ),
    byStoreCollection: index('shopify_collection_products_store_collection_idx').on(
      t.storeId,
      t.shopifyCollectionId,
    ),
  }),
);

/** Collections tab: merchant's picks for collection-level enablement. */
export const shopifyEnabledCollections = pgTable(
  'shopify_enabled_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId),
  }),
);

/** Exclusion tab, collections sub-section. */
export const shopifyExcludedCollections = pgTable(
  'shopify_excluded_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId),
  }),
);
