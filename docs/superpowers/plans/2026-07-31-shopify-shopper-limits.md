# Shopify Shopper Limits, Email Capture & Retention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shopify merchants server-enforced spend limits, opt-in shopper email capture with consent, and scheduled deletion of shopper PII.

**Architecture:** Server-authoritative. A new `shopify_shoppers` table gives every browser a row; limits are enforced in `apps/api/src/modules/shopify/customer.routes.ts` immediately before the credit transaction. The store daily cap uses an atomic Redis `INCR`; the per-shopper cap counts `jobs` rows in Postgres so an anonymous→email identity upgrade cannot reset it. A dispatcher `setInterval` sweeper deletes expired R2 objects and shopper rows.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM (PostgreSQL 16), ioredis, Vitest, React 19 + Polaris 13, vanilla JS theme-extension widget.

**Spec:** `docs/superpowers/specs/2026-07-31-shopify-shopper-limits-design.md`

## Global Constraints

- **Every limit is Off unless the merchant turns it on.** Absent setting = no enforcement. A dropdown's pre-selected value is *not* an enforced default. No platform-imposed ceiling, no clamping.
- **A refusal never consumes quota.** The store-cap Redis counter is reserved by `INCR` and released with `DECR` on any refusal or failure downstream of it.
- **Counting identity precedence:** `shopify_customer_id` → `email` → `client_id`. Row identity is always `(store_id, client_id)` — one row per browser, never merged.
- **`jobs` rows are never deleted by retention.** They are billing records. `jobs.shopify_shopper_id` is `ON DELETE SET NULL`.
- **Refusals are HTTP 202** with `{ message, reason }`. `reason` is one of `email_required` | `shopper_limit` | `store_limit`. Existing deployed widgets ignore unknown fields and render `message`.
- **`store_limit`'s message must not reveal that a cap exists.** Exact copy: `"Try-on isn't available right now."`
- **Consent checkbox is unchecked by default.** A pre-checked box is not valid GDPR consent.
- Store-local day boundaries via `shopify_stores.iana_timezone`; UTC fallback when null.
- ESM only (`.js` extensions on relative imports), pino via `@tryme/logger` (no `console.log`), Biome formatting enforced by lefthook pre-commit.
- Integration tests live in `apps/api/test/integration/` (run via `vitest.integration.config.ts`); unit tests alongside source or in `apps/api/test/`.

## File Structure

**Create:**
- `packages/db/src/migrations/0134_shopify_shoppers.sql` — table, columns, indexes
- `apps/api/src/modules/shopify/shopper.ts` — `resolveShopper`, `countingIdentity`
- `apps/api/src/modules/shopify/store-day.ts` — store-local day bucket key
- `apps/api/src/modules/shopify/limits.ts` — the three limit checks
- `apps/api/src/modules/shopify/settings.routes.ts` — `PATCH /v1/shopify/settings`
- `apps/api/src/modules/shopify/shoppers.routes.ts` — email list + CSV export
- `apps/api/src/modules/shopify/gdpr.ts` — redaction/data-request helpers
- `apps/dispatcher/src/shopify/retention.ts` — retention sweeper
- `apps/shopify/src/pages/SettingsPage.tsx` — Limits + Data tabs
- Tests: `apps/api/src/modules/shopify/shopper.test.ts`, `store-day.test.ts`, `apps/api/test/integration/shopify-limits.test.ts`, `shopify-retention.test.ts`, `shopify-settings.test.ts`

**Modify:**
- `packages/db/src/schema/shopify.ts` — `shopifyShoppers`, `ShopifyStoreSettings`, `ianaTimezone`
- `packages/db/src/schema/jobs.ts` — `shopifyShopperId`
- `packages/types/src/widget.ts` — request schemas gain identity fields; settings schemas
- `apps/api/src/modules/shopify/customer.routes.ts` — enforcement wiring
- `apps/api/src/modules/shopify/auth.routes.ts` — capture `iana_timezone`
- `apps/api/src/modules/shopify/webhook.routes.ts` — real GDPR handlers
- `apps/api/src/modules/shopify/routes.ts` — register new route modules
- `apps/api/src/modules/shopify/me.routes.ts` — usage stats
- `apps/dispatcher/src/index.ts` — retention interval
- `apps/shopify/src/{App.tsx,types.ts}`, `components/AppNavMenu.tsx`, `pages/DashboardPage.tsx`
- `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid` — customer data attrs, email form markup
- `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js` — client ID, email gate, reason handling
- `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css` — email form styles
- `docs/progress.md`

---

### Task 1: Database schema and migration

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Modify: `packages/db/src/schema/jobs.ts:48`
- Create: `packages/db/src/migrations/0134_shopify_shoppers.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `schema.shopifyShoppers` table; `schema.jobs.shopifyShopperId`; `schema.shopifyStores.ianaTimezone`; `ShopifyStoreSettings` with `limits` and `retention` sub-objects

- [ ] **Step 1: Add the `shopifyShoppers` table to the schema**

In `packages/db/src/schema/shopify.ts`, append after `shopifyProductGarments`:

```ts
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
```

Add `index` to the `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 2: Add `ianaTimezone` to `shopifyStores` and rewrite `ShopifyStoreSettings`**

In the same file, add to the `shopifyStores` column list (after `scope`):

```ts
  // The store's local timezone, from shop.json at install. Drives day
  // boundaries for the store daily cap — a merchant who sets "200/day" and
  // watches it reset at 05:30 local time will file a bug. Null for rows that
  // predate this column; those fall back to UTC until the next reinstall.
  ianaTimezone: text('iana_timezone'),
```

Replace the `ShopifyStoreSettings` interface entirely. Note the four removed
fields (`buttonText`, `buttonColor`, `position`, `customCss`) — verified dead,
all widget appearance lives in the theme block's `{% schema %}`:

```ts
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

export interface ShopifyStoreSettings {
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
  limits?: ShopifyStoreLimits;
  retention?: ShopifyStoreRetention;
}
```

- [ ] **Step 3: Add `shopifyShopperId` to `jobs`**

In `packages/db/src/schema/jobs.ts`, immediately after the `shopifyStoreId`
column (line ~48), add:

```ts
  // SET NULL, never CASCADE: retention and GDPR erasure delete shopper rows,
  // but a jobs row is a billing record tied to a credit deduction and a ledger
  // entry. A cascade here would delete billing history.
  shopifyShopperId: uuid('shopify_shopper_id').references(() => shopifyShoppers.id, {
    onDelete: 'set null',
  }),
```

Add `shopifyShoppers` to the existing `import { shopifyStores } from './shopify.js';` line.

- [ ] **Step 4: Write the migration SQL**

Create `packages/db/src/migrations/0134_shopify_shoppers.sql`:

```sql
CREATE TABLE IF NOT EXISTS "shopify_shoppers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL REFERENCES "shopify_stores"("id") ON DELETE cascade,
  "client_id" text NOT NULL,
  "shopify_customer_id" bigint,
  "email" text,
  "email_consent" boolean DEFAULT false NOT NULL,
  "email_captured_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_shoppers_store_id_client_id_unique" UNIQUE("store_id","client_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_shoppers_store_email_idx" ON "shopify_shoppers" ("store_id","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_shoppers_store_customer_idx" ON "shopify_shoppers" ("store_id","shopify_customer_id");
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "shopify_shopper_id" uuid REFERENCES "shopify_shoppers"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN IF NOT EXISTS "iana_timezone" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_shopify_shopper_idx" ON "jobs" ("shopify_shopper_id") WHERE "shopify_shopper_id" IS NOT NULL;
```

- [ ] **Step 5: Register the migration in the journal**

In `packages/db/src/migrations/meta/_journal.json`, append to `entries` (the
last existing entry is idx 133; copy the shape of its neighbours exactly, and
set `when` to the current epoch milliseconds):

```json
{
  "idx": 134,
  "version": "7",
  "when": 1785000000000,
  "tag": "0134_shopify_shoppers",
  "breakpoints": true
}
```

- [ ] **Step 6: Apply the migration and typecheck**

Run: `pnpm db:migrate && pnpm --filter @tryme/db typecheck`
Expected: migration applies cleanly, typecheck passes.

If `pnpm db:migrate` silently skips the file, apply it manually using the
`apply-one.ts` recipe in CLAUDE.md's "Migration Index Conflicts" section.

- [ ] **Step 7: Verify nothing referenced the removed settings fields**

Run: `grep -rn "buttonText\|buttonColor\|customCss\|settings.position" --include=*.ts --include=*.tsx apps/api/src apps/shopify/src apps/admin-web/src packages/`
Expected: no matches. (If any appear, they must be removed in this task.)

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "feat(shopify): add shopify_shoppers table and store timezone

Row identity is (store_id, client_id) - one row per browser, never merged.
jobs.shopify_shopper_id is SET NULL so purging a shopper cannot cascade into
billing history.

Also drops four dead ShopifyStoreSettings fields (buttonText, buttonColor,
position, customCss); all widget appearance lives in the theme block schema."
```

---

### Task 2: Shopper resolution and counting identity

**Files:**
- Create: `apps/api/src/modules/shopify/shopper.ts`
- Create: `apps/api/src/modules/shopify/shopper.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyShoppers` (Task 1)
- Produces:
  - `type ShopperIdentityInput = { clientId: string; shopifyCustomerId?: number | null; email?: string | null }`
  - `type CountingIdentity = { kind: 'customer'; value: number } | { kind: 'email'; value: string } | { kind: 'client'; value: string }`
  - `countingIdentity(row: ShopperRow): CountingIdentity`
  - `resolveShopper(app: FastifyInstance, storeId: string, input: ShopperIdentityInput): Promise<ShopperRow>`
  - `shopperIdFilter(storeId: string, id: CountingIdentity): SQL` — a Drizzle predicate selecting every shopper row in the store sharing that identity

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/modules/shopify/shopper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countingIdentity, normalizeEmail } from './shopper.js';

const base = {
  id: 'row-1',
  storeId: 'store-1',
  clientId: 'client-abc',
  shopifyCustomerId: null as number | null,
  email: null as string | null,
  emailConsent: false,
  emailCapturedAt: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
};

describe('countingIdentity', () => {
  it('prefers the shopify customer id above all else', () => {
    expect(countingIdentity({ ...base, shopifyCustomerId: 99, email: 'a@b.com' })).toEqual({
      kind: 'customer',
      value: 99,
    });
  });

  it('falls back to email when there is no customer id', () => {
    expect(countingIdentity({ ...base, email: 'A@B.com' })).toEqual({
      kind: 'email',
      value: 'a@b.com',
    });
  });

  it('falls back to the anonymous client id when nothing stronger exists', () => {
    expect(countingIdentity(base)).toEqual({ kind: 'client', value: 'client-abc' });
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims so casing cannot fork a counting bucket', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
  });

  it('returns null for blank input', () => {
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopper`
Expected: FAIL — cannot resolve `./shopper.js`.

- [ ] **Step 3: Implement `shopper.ts`**

Create `apps/api/src/modules/shopify/shopper.ts`:

```ts
import { schema } from '@tryme/db';
import { type SQL, and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export type ShopperRow = typeof schema.shopifyShoppers.$inferSelect;

export interface ShopperIdentityInput {
  clientId: string;
  shopifyCustomerId?: number | null;
  email?: string | null;
}

export type CountingIdentity =
  | { kind: 'customer'; value: number }
  | { kind: 'email'; value: string }
  | { kind: 'client'; value: string };

/** Lowercase + trim, so "A@b.com" and "a@b.com" cannot fork one shopper into
 *  two counting buckets. Returns null for blank/absent input. */
export function normalizeEmail(email?: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * The strongest identity signal available for this shopper.
 *
 * Counting spans every row in the store sharing this signal, which is what
 * makes an anonymous -> email upgrade tighten a shopper's limit instead of
 * resetting it. Supplying identity can only ever narrow the bucket a shopper
 * counts against, never widen it — so a forged value cannot loosen a limit.
 */
export function countingIdentity(row: ShopperRow): CountingIdentity {
  if (row.shopifyCustomerId != null) return { kind: 'customer', value: row.shopifyCustomerId };
  const email = normalizeEmail(row.email);
  if (email) return { kind: 'email', value: email };
  return { kind: 'client', value: row.clientId };
}

/** Drizzle predicate matching every shopper row in the store that shares this identity. */
export function shopperIdFilter(storeId: string, id: CountingIdentity): SQL {
  const col =
    id.kind === 'customer'
      ? eq(schema.shopifyShoppers.shopifyCustomerId, id.value)
      : id.kind === 'email'
        ? eq(schema.shopifyShoppers.email, id.value)
        : eq(schema.shopifyShoppers.clientId, id.value);
  return and(eq(schema.shopifyShoppers.storeId, storeId), col) as SQL;
}

/**
 * Upsert this browser's shopper row and stamp last_seen_at.
 *
 * Row identity is (storeId, clientId) — one row per browser, never merged.
 * A stronger signal (customer id / email) enriches the existing row rather
 * than creating a second one. Never nulls a previously-known signal: a
 * logged-in shopper who logs out must not shed the identity they already gave.
 */
export async function resolveShopper(
  app: FastifyInstance,
  storeId: string,
  input: ShopperIdentityInput,
): Promise<ShopperRow> {
  const email = normalizeEmail(input.email);
  const now = new Date();

  const patch: Record<string, unknown> = { lastSeenAt: now };
  if (input.shopifyCustomerId != null) patch.shopifyCustomerId = input.shopifyCustomerId;
  if (email) {
    patch.email = email;
    patch.emailCapturedAt = now;
  }

  const [row] = await app.db
    .insert(schema.shopifyShoppers)
    .values({
      storeId,
      clientId: input.clientId,
      shopifyCustomerId: input.shopifyCustomerId ?? null,
      email,
      emailCapturedAt: email ? now : null,
    })
    .onConflictDoUpdate({
      target: [schema.shopifyShoppers.storeId, schema.shopifyShoppers.clientId],
      set: patch,
    })
    .returning();

  return row;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopper`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/shopper.ts apps/api/src/modules/shopify/shopper.test.ts
git commit -m "feat(shopify): shopper resolution and counting identity

Row identity is (storeId, clientId); counting identity is the strongest
signal available (customer id > email > client id). Counting spans all rows
sharing the signal, so an anonymous -> email upgrade tightens a shopper's
limit rather than handing them a fresh bucket."
```

---

### Task 3: Store-local day bucket, and capturing the timezone at install

**Files:**
- Create: `apps/api/src/modules/shopify/store-day.ts`
- Create: `apps/api/src/modules/shopify/store-day.test.ts`
- Modify: `apps/api/src/modules/shopify/auth.routes.ts:12-22` (interface), `:163-187` (fetch + details), `:42-80` (upsert)

**Interfaces:**
- Consumes: `schema.shopifyStores.ianaTimezone` (Task 1)
- Produces:
  - `storeDayKey(timezone: string | null, now?: Date): string` — `YYYYMMDD` in the store's local day
  - `windowStart(timezone: string | null, window: 'day' | 'week' | 'month', now?: Date): Date` — UTC instant at which the current calendar window began

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/modules/shopify/store-day.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { storeDayKey, windowStart } from './store-day.js';

describe('storeDayKey', () => {
  it('uses the store local day, not the UTC day', () => {
    // 2026-03-01T20:00:00Z is already 2026-03-02 in Asia/Kolkata (UTC+5:30).
    const at = new Date('2026-03-01T20:00:00Z');
    expect(storeDayKey('Asia/Kolkata', at)).toBe('20260302');
    expect(storeDayKey(null, at)).toBe('20260301');
  });

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    const at = new Date('2026-03-01T20:00:00Z');
    expect(storeDayKey('Not/AZone', at)).toBe('20260301');
  });
});

describe('windowStart', () => {
  it('starts the day window at local midnight', () => {
    const at = new Date('2026-03-01T20:00:00Z'); // 2026-03-02 01:30 IST
    // Local midnight of 2026-03-02 IST is 2026-03-01T18:30:00Z.
    expect(windowStart('Asia/Kolkata', 'day', at).toISOString()).toBe('2026-03-01T18:30:00.000Z');
  });

  it('starts the week window on Monday', () => {
    const at = new Date('2026-03-05T12:00:00Z'); // a Thursday
    expect(windowStart('UTC', 'week', at).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('starts the month window on the first', () => {
    const at = new Date('2026-03-05T12:00:00Z');
    expect(windowStart('UTC', 'month', at).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test -- store-day`
Expected: FAIL — cannot resolve `./store-day.js`.

- [ ] **Step 3: Implement `store-day.ts`**

Create `apps/api/src/modules/shopify/store-day.ts`:

```ts
/**
 * Day/window boundaries in the store's own timezone.
 *
 * A merchant who sets "200 per day" and watches the counter reset at 05:30
 * local time will file a bug, so every boundary here is local-calendar, not
 * UTC and not rolling.
 */

/** Local wall-clock parts for an instant, in the given zone. Falls back to UTC
 *  for null/invalid zones rather than throwing — a bad row must not break the
 *  limit path. */
function localParts(
  timezone: string | null,
  at: Date,
): { year: number; month: number; day: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  // en-CA formats as YYYY-MM-DD.
  const [year, month, day] = fmt.format(at).split('-').map(Number);
  return { year, month, day };
}

/** The store-local calendar day as YYYYMMDD, for use in a Redis counter key. */
export function storeDayKey(timezone: string | null, now: Date = new Date()): string {
  const { year, month, day } = localParts(timezone, now);
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/** The UTC offset (ms) the zone was at for this instant. */
function zoneOffsetMs(timezone: string | null, at: Date): number {
  const { year, month, day } = localParts(timezone, at);
  let hour = 0;
  let minute = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    [hour, minute] = parts.split(':').map(Number);
  } catch {
    // UTC fallback: offset is zero, the values above already hold.
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Truncate `at` to whole minutes so the subtraction yields the offset alone.
  return asUtc - Math.floor(at.getTime() / 60000) * 60000;
}

/**
 * The UTC instant at which the current local calendar window began.
 * Weeks start Monday (ISO).
 */
export function windowStart(
  timezone: string | null,
  window: 'day' | 'week' | 'month',
  now: Date = new Date(),
): Date {
  const offset = zoneOffsetMs(timezone, now);
  const { year, month, day } = localParts(timezone, now);

  if (window === 'month') return new Date(Date.UTC(year, month - 1, 1) - offset);

  if (window === 'week') {
    // Day-of-week of the LOCAL date, computed in UTC space to avoid the host
    // timezone leaking in.
    const localMidnightUtc = Date.UTC(year, month - 1, day);
    const dow = new Date(localMidnightUtc).getUTCDay(); // 0 = Sunday
    const daysSinceMonday = (dow + 6) % 7;
    return new Date(localMidnightUtc - daysSinceMonday * 86_400_000 - offset);
  }

  return new Date(Date.UTC(year, month - 1, day) - offset);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- store-day`
Expected: PASS, 5 tests.

- [ ] **Step 5: Capture the timezone at install**

In `apps/api/src/modules/shopify/auth.routes.ts`:

Add to the `ShopDetails` interface (after `address?: string;`):

```ts
  ianaTimezone?: string;
```

In the `shop.json` response type (around line 163), add to the destructured
shop shape:

```ts
        iana_timezone?: string;
```

In the `details` object literal (around line 177), add:

```ts
      ianaTimezone: s.iana_timezone,
```

In `upsertShopifyStore`, add `ianaTimezone: shop.ianaTimezone ?? null,` to
**both** the `.set({...})` of the existing-store update and the `.values({...})`
of the insert, alongside `scope`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/store-day.ts apps/api/src/modules/shopify/store-day.test.ts apps/api/src/modules/shopify/auth.routes.ts
git commit -m "feat(shopify): store-local day and window boundaries

Limits reset on the store's local calendar, not UTC. iana_timezone comes back
on the same shop.json call already made at install, so this costs one extra
destructured field. Null/invalid zones fall back to UTC rather than throwing."
```

---

### Task 4: Settings schemas and the PATCH endpoint

**Files:**
- Modify: `packages/types/src/widget.ts:402-421`
- Create: `apps/api/src/modules/shopify/settings.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Create: `apps/api/test/integration/shopify-settings.test.ts`

**Interfaces:**
- Consumes: `ShopifyStoreSettings` (Task 1)
- Produces:
  - `ShopifyStoreSettingsPatch` Zod schema exported from `@tryme/types`
  - `PATCH /v1/shopify/settings` → `{ settings: ShopifyStoreSettings }`
  - `shopifySettingsRoutes(app)` registered in `routes.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/shopify-settings.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('shopify settings routes', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('rejects a limit value outside the allowed option set', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: 777 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('merges limits without clobbering unrelated settings', async () => {
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { themeBlockConfirmed: true } })
      .where(eq(schema.shopifyStores.id, storeId));

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: 250, perShopperCap: 5, perShopperWindow: 'week' } },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.themeBlockConfirmed).toBe(true);
    expect(row.settings.limits?.storeDailyCap).toBe(250);
    expect(row.settings.limits?.perShopperWindow).toBe('week');
  });

  it('accepts null to turn a limit back off', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: 100 } },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: null } },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.limits?.storeDailyCap).toBeNull();
  });
});
```

**Auth setup for this file** — copy this preamble verbatim from
`apps/api/test/shopify-me.test.ts`, which is the established mechanism
(`requireShopifySession` verifies a real signed session token; there is no test
bypass header):

```ts
import { upsertShopifyStore } from '../../src/modules/shopify/auth.routes.js';
import { signSessionToken } from '../helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let storeId: string;
let token: string;

beforeAll(async () => {
  ctx = await startContainers();
  app = await buildTestApp(ctx, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 77,
      shopDomain: 'settings.myshopify.com',
      myshopifyDomain: 'settings.myshopify.com',
      name: 'S',
      email: 's@s.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('settings.myshopify.com', API_SECRET, API_KEY);
});
```

Every request in this file authenticates with `headers: { authorization: \`Bearer ${token}\` }`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-settings.test.ts`
Expected: FAIL — 404 on `/v1/shopify/settings`.

- [ ] **Step 3: Add the Zod schemas**

In `packages/types/src/widget.ts`, append after `ShopifyCustomerPhotoPreviewRequest`:

```ts
// Fixed option sets, not free ranges. A dropdown of allowed values eliminates
// the "2000 instead of 200" typo class, and an out-of-set value is a 400
// rather than something that lands silently in JSONB.
export const STORE_DAILY_CAP_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000] as const;
export const PER_SHOPPER_CAP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const EMAIL_AFTER_N_OPTIONS = [0, 1, 2, 3, 5] as const;
export const SHOPPER_PHOTO_RETENTION_DAYS = [7, 30, 90] as const;
export const RESULT_RETENTION_DAYS = [30, 90, 180, 365] as const;
export const SHOPPER_RECORD_RETENTION_DAYS = [90, 180, 365] as const;

const optionOrOff = <T extends number>(options: readonly T[]) =>
  z.union([z.literal(null), z.number().refine((n) => (options as readonly number[]).includes(n))]);

export const ShopifyStoreLimitsPatch = z.object({
  storeDailyCap: optionOrOff(STORE_DAILY_CAP_OPTIONS).optional(),
  perShopperCap: optionOrOff(PER_SHOPPER_CAP_OPTIONS).optional(),
  perShopperWindow: z.enum(['day', 'week', 'month']).optional(),
  emailAfterNTryOns: optionOrOff(EMAIL_AFTER_N_OPTIONS).optional(),
});

export const ShopifyStoreRetentionPatch = z.object({
  shopperPhotoDays: optionOrOff(SHOPPER_PHOTO_RETENTION_DAYS).optional(),
  resultDays: optionOrOff(RESULT_RETENTION_DAYS).optional(),
  shopperRecordDays: optionOrOff(SHOPPER_RECORD_RETENTION_DAYS).optional(),
});

export const ShopifyStoreSettingsPatch = z.object({
  limits: ShopifyStoreLimitsPatch.optional(),
  retention: ShopifyStoreRetentionPatch.optional(),
});
export type ShopifyStoreSettingsPatch = z.infer<typeof ShopifyStoreSettingsPatch>;
```

Also extend the customer request schemas in the same file — the widget will
send identity on every call (Task 6 consumes these):

```ts
export const ShopifyCustomerPresignRequest = z.object({
  contentType: z.string(),
  contentLength: z.number().int().positive().max(20 * 1024 * 1024),
  clientId: z.string().uuid().optional(),
});
```

and

```ts
export const ShopifyCustomerJobRequest = z.object({
  customerPhotoKey: z.string(),
  shopifyProductId: z.number().int().positive(),
  // All three are client-supplied and forgeable. That is acceptable because
  // supplying identity can only narrow the bucket a shopper counts against,
  // never widen it — no authorization decision depends on them.
  clientId: z.string().uuid().optional(),
  shopifyCustomerId: z.number().int().positive().optional(),
  email: z.string().email().max(320).optional(),
  emailConsent: z.boolean().optional(),
});
```

Leave the existing `export type` lines beneath each schema unchanged.

- [ ] **Step 4: Implement the settings route**

Create `apps/api/src/modules/shopify/settings.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { ShopifyStoreSettingsPatch } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function shopifySettingsRoutes(app: FastifyInstance) {
  app.patch(
    '/v1/shopify/settings',
    { preHandler: app.requireShopifySession, schema: { body: ShopifyStoreSettingsPatch } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const body = req.body as ShopifyStoreSettingsPatch;

      // Shallow-merge each sub-object so a PATCH touching only `limits` cannot
      // drop `retention`, `themeBlockConfirmed`, or `workflowTemplateId`.
      const settings = {
        ...store.settings,
        ...(body.limits ? { limits: { ...store.settings.limits, ...body.limits } } : {}),
        ...(body.retention
          ? { retention: { ...store.settings.retention, ...body.retention } }
          : {}),
      };

      await app.db
        .update(schema.shopifyStores)
        .set({ settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));

      req.log.info(
        { storeId: store.id, changed: Object.keys(body) },
        'shopify store settings updated',
      );
      return { settings };
    },
  );
}
```

- [ ] **Step 5: Register the route module**

In `apps/api/src/modules/shopify/routes.ts`, import and register it beside the
existing modules:

```ts
import { shopifySettingsRoutes } from './settings.routes.js';
```

and inside the plugin body, next to the other `await app.register(...)` calls:

```ts
  await app.register(shopifySettingsRoutes);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-settings.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/shopify/settings.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/integration/shopify-settings.test.ts
git commit -m "feat(shopify): merchant settings endpoint with fixed option sets

Limits and retention are dropdown option sets validated as Zod unions, so an
out-of-set value is a 400 rather than something that lands silently in JSONB.
PATCH shallow-merges each sub-object so touching limits cannot drop retention."
```

---

### Task 5: Limit enforcement in the customer job route

**Files:**
- Create: `apps/api/src/modules/shopify/limits.ts`
- Modify: `apps/api/src/modules/shopify/customer.routes.ts:167-300`
- Create: `apps/api/test/integration/shopify-limits.test.ts`

**Interfaces:**
- Consumes: `resolveShopper`, `countingIdentity`, `shopperIdFilter` (Task 2); `storeDayKey`, `windowStart` (Task 3); `ShopifyStoreLimits` (Task 1)
- Produces:
  - `type LimitRefusal = { reason: 'email_required' | 'shopper_limit' | 'store_limit'; message: string }`
  - `checkShopperLimits(app, store, shopper): Promise<LimitRefusal | null>`
  - `reserveStoreDailySlot(app, store): Promise<{ ok: true; release: () => Promise<void> } | { ok: false }>`

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/shopify-limits.test.ts`. Reuse the seed
helpers from `apps/api/test/integration/shopify-customer.test.ts` verbatim
(`seedOwner`, `seedStore`, `seedDefaultFunnelTemplate`, `seedGarment`,
`uploadCustomerPhoto`) — copy them in; do not import across test files.

```ts
  async function setLimits(storeId: string, limits: Record<string, unknown>) {
    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { ...row.settings, limits } })
      .where(eq(schema.shopifyStores.id, storeId));
  }

  async function createJob(store: { storeKey: string }, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: body,
    });
  }

  it('enforces the store daily cap and charges nothing for the refused request', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 5001);
    await setLimits(store.id, { storeDailyCap: 50 });
    // Pre-fill the counter to the cap so only one request is needed.
    const dayKey = storeDayKey(null);
    await app.redis.set(`shopify:cap:store:${store.id}:${dayKey}`, '50');

    const photo = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const res = await createJob(store, {
      customerPhotoKey: photo,
      shopifyProductId: 5001,
      clientId: randomUUID(),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().reason).toBe('store_limit');
    // The refusal must not reveal that a cap exists.
    expect(res.json().message).toBe("Try-on isn't available right now.");

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, owner.id));
    expect(credits.balance).toBe(100);
    // Reserved slot was released, so the counter is back at the cap.
    expect(await app.redis.get(`shopify:cap:store:${store.id}:${dayKey}`)).toBe('50');
  });

  it('per-shopper cap survives an anonymous -> email identity upgrade', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 5002);
    await setLimits(store.id, { perShopperCap: 1, perShopperWindow: 'day' });

    const clientA = randomUUID();
    const photo1 = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const first = await createJob(store, {
      customerPhotoKey: photo1,
      shopifyProductId: 5002,
      clientId: clientA,
      email: 'shopper@example.com',
    });
    expect(first.statusCode).toBe(200);

    // Same shopper, brand-new browser (fresh clientId) but the same email.
    // A Redis-keyed counter would hand them a fresh bucket here; the Postgres
    // count must not.
    const photo2 = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const second = await createJob(store, {
      customerPhotoKey: photo2,
      shopifyProductId: 5002,
      clientId: randomUUID(),
      email: 'Shopper@Example.com',
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().reason).toBe('shopper_limit');
  });

  it('gates on email after N try-ons, then accepts the retry with the same photo', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 5003);
    await setLimits(store.id, { emailAfterNTryOns: 1 });

    const clientId = randomUUID();
    const photo1 = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    expect(
      (await createJob(store, { customerPhotoKey: photo1, shopifyProductId: 5003, clientId }))
        .statusCode,
    ).toBe(200);

    const photo2 = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const gated = await createJob(store, {
      customerPhotoKey: photo2,
      shopifyProductId: 5003,
      clientId,
    });
    expect(gated.statusCode).toBe(202);
    expect(gated.json().reason).toBe('email_required');

    // Retry with the SAME photo key — the upload is still valid, nothing re-uploads.
    const retry = await createJob(store, {
      customerPhotoKey: photo2,
      shopifyProductId: 5003,
      clientId,
      email: 'gated@example.com',
      emailConsent: true,
    });
    expect(retry.statusCode).toBe(200);

    const [shopper] = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.clientId, clientId));
    expect(shopper.email).toBe('gated@example.com');
    expect(shopper.emailConsent).toBe(true);
  });

  it('links the created job to the shopper row', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 5004);
    const clientId = randomUUID();
    const photo = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const res = await createJob(store, {
      customerPhotoKey: photo,
      shopifyProductId: 5004,
      clientId,
    });
    expect(res.statusCode).toBe(200);
    const [job] = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, res.json().jobId));
    expect(job.shopifyShopperId).not.toBeNull();
  });

  it('enforces nothing when the merchant has configured no limits', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 5005);
    const clientId = randomUUID();
    for (let i = 0; i < 3; i++) {
      const photo = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
      const res = await createJob(store, {
        customerPhotoKey: photo,
        shopifyProductId: 5005,
        clientId,
      });
      expect(res.statusCode).toBe(200);
    }
  });
```

Import `randomUUID` from `node:crypto` and `storeDayKey` from
`../../src/modules/shopify/store-day.js` at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-limits.test.ts`
Expected: FAIL — no `reason` field, no shopper linkage.

- [ ] **Step 3: Implement `limits.ts`**

Create `apps/api/src/modules/shopify/limits.ts`:

```ts
import { schema } from '@tryme/db';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type ShopperRow, countingIdentity, shopperIdFilter } from './shopper.js';
import { storeDayKey, windowStart } from './store-day.js';

type Store = typeof schema.shopifyStores.$inferSelect;

export interface LimitRefusal {
  reason: 'email_required' | 'shopper_limit' | 'store_limit';
  message: string;
}

/** Every shopper row in this store sharing the shopper's counting identity. */
async function siblingShopperIds(
  app: FastifyInstance,
  store: Store,
  shopper: ShopperRow,
): Promise<string[]> {
  const rows = await app.db
    .select({ id: schema.shopifyShoppers.id })
    .from(schema.shopifyShoppers)
    .where(shopperIdFilter(store.id, countingIdentity(shopper)));
  return rows.map((r) => r.id);
}

/** Successful generations by this shopper, optionally bounded to a window start. */
async function countShopperJobs(
  app: FastifyInstance,
  shopperIds: string[],
  since: Date | null,
): Promise<number> {
  if (shopperIds.length === 0) return 0;
  const clauses = [inArray(schema.jobs.shopifyShopperId, shopperIds)];
  if (since) clauses.push(gte(schema.jobs.createdAt, since));
  const [row] = await app.db
    .select({ n: count() })
    .from(schema.jobs)
    .where(and(...clauses));
  return row.n;
}

/**
 * The email gate and the per-shopper cap, in that order.
 *
 * Most-specific first, so a shopper sees the actionable refusal (supply an
 * email) rather than a dead end when more than one applies.
 *
 * Both counts come from Postgres rather than Redis, deliberately: a Redis
 * counter must be keyed on the counting identity, and identity UPGRADES
 * mid-session (anonymous -> email). That would hand the shopper a fresh, empty
 * bucket — supply an email, get your quota back — and the gate would defeat
 * the cap. Counting jobs across every row sharing the identity is correct
 * across upgrades by construction.
 */
export async function checkShopperLimits(
  app: FastifyInstance,
  store: Store,
  shopper: ShopperRow,
): Promise<LimitRefusal | null> {
  const limits = store.settings.limits;
  if (!limits) return null;

  const ids = await siblingShopperIds(app, store, shopper);

  const emailAfter = limits.emailAfterNTryOns;
  if (emailAfter != null && !shopper.email) {
    // All-time count for this store, NOT the per-shopper cap's calendar window.
    const lifetime = await countShopperJobs(app, ids, null);
    if (lifetime >= emailAfter) {
      return { reason: 'email_required', message: 'Enter your email to continue.' };
    }
  }

  const cap = limits.perShopperCap;
  if (cap != null) {
    const since = windowStart(store.ianaTimezone, limits.perShopperWindow ?? 'week');
    const used = await countShopperJobs(app, ids, since);
    if (used >= cap) {
      return {
        reason: 'shopper_limit',
        message: "You've reached your try-on limit. Check back later.",
      };
    }
  }

  return null;
}

/**
 * Reserve one slot against the store's daily cap.
 *
 * INCR-then-check, never check-then-INCR: the latter lets two concurrent
 * requests at cap-1 both pass. The returned `release` puts the slot back and
 * must be called on any refusal or failure downstream of this call — a refusal
 * never consumes quota. A crash between reserve and release overshoots the day
 * by one, which fails closed, not open.
 */
export async function reserveStoreDailySlot(
  app: FastifyInstance,
  store: Store,
): Promise<{ ok: true; release: () => Promise<void> } | { ok: false }> {
  const cap = store.settings.limits?.storeDailyCap;
  if (cap == null) return { ok: true, release: async () => {} };

  const key = `shopify:cap:store:${store.id}:${storeDayKey(store.ianaTimezone)}`;
  const used = await app.redis.incr(key);
  // 48h, not 24: covers any timezone's day plus DST slack, and the key is
  // day-scoped so a stale one is never read again.
  if (used === 1) await app.redis.expire(key, 48 * 60 * 60);

  if (used > cap) {
    await app.redis.decr(key);
    return { ok: false };
  }

  let released = false;
  return {
    ok: true,
    release: async () => {
      if (released) return;
      released = true;
      await app.redis.decr(key);
    },
  };
}
```

- [ ] **Step 4: Wire enforcement into the job route**

In `apps/api/src/modules/shopify/customer.routes.ts`, add imports:

```ts
import { checkShopperLimits, reserveStoreDailySlot } from './limits.js';
import { resolveShopper } from './shopper.js';
```

In the `/v1/shopify/customer/jobs` handler, replace the destructure of
`req.body` with one that includes the identity fields:

```ts
      const { customerPhotoKey, shopifyProductId, clientId, shopifyCustomerId, email, emailConsent } =
        req.body as {
          customerPhotoKey: string;
          shopifyProductId: number;
          clientId?: string;
          shopifyCustomerId?: number;
          email?: string;
          emailConsent?: boolean;
        };
```

Then, immediately **after** the `workflowTemplateId` null-check block and
**before** `const jobId = randomUUID();`, insert:

```ts
      // Limits sit here, after the garment and workflow checks: don't spend a
      // limit on a request that was going to fail anyway, and don't let a limit
      // refusal leak whether a product is enabled.
      //
      // clientId is optional for backward compatibility with widget versions
      // already deployed in the wild. Without it there is no shopper row, so
      // per-shopper limits cannot apply — the store daily cap still does.
      let shopper: Awaited<ReturnType<typeof resolveShopper>> | null = null;
      if (clientId) {
        shopper = await resolveShopper(app, storeId, {
          clientId,
          shopifyCustomerId: shopifyCustomerId ?? null,
          email: email ?? null,
        });
        if (email && emailConsent && !shopper.emailConsent) {
          await app.db
            .update(schema.shopifyShoppers)
            .set({ emailConsent: true })
            .where(eq(schema.shopifyShoppers.id, shopper.id));
          shopper = { ...shopper, emailConsent: true };
        }

        const refusal = await checkShopperLimits(app, store, shopper);
        if (refusal) return reply.code(202).send(refusal);
      }

      const slot = await reserveStoreDailySlot(app, store);
      if (!slot.ok) {
        // Deliberately vague: the storefront must not advertise that the
        // merchant has a spend cap, or where it sits.
        return reply
          .code(202)
          .send({ reason: 'store_limit', message: "Try-on isn't available right now." });
      }
```

Wrap the existing `await app.db.transaction(...)` and the subsequent `XADD` in
a `try`/`catch` that releases the slot on failure:

```ts
      try {
        await app.db.transaction(async (tx) => {
          /* ...existing transaction body unchanged... */
        });
        /* ...existing XADD / enqueue call unchanged... */
      } catch (err) {
        await slot.release();
        throw err;
      }
```

Inside the transaction's `jobs` insert, add the shopper link alongside
`shopifyStoreId`:

```ts
          shopifyShopperId: shopper?.id ?? null,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-limits.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the existing shopify integration suite for regressions**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-customer.test.ts`
Expected: PASS, all pre-existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/limits.ts apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/shopify-limits.test.ts
git commit -m "feat(shopify): enforce store daily cap, per-shopper cap and email gate

Store cap is an atomic Redis INCR reserved before the credit transaction and
released on any refusal, so a refusal never consumes quota. Per-shopper counts
come from Postgres across every row sharing the counting identity - a Redis
counter would reset when a shopper upgrades from anonymous to email, letting
the gate defeat the cap."
```

---

### Task 6: Widget — client ID, customer prefill, email gate

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js:280-340, 415-435`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`

**Interfaces:**
- Consumes: the 202 `{ reason, message }` refusal contract (Task 5); extended `ShopifyCustomerJobRequest` (Task 4)
- Produces: no server-side interface. Widget sends `clientId` on `/presign` and `/jobs`, plus `shopifyCustomerId` / `email` / `emailConsent` on `/jobs` when known.

- [ ] **Step 1: Emit the logged-in customer from Liquid**

In `tryon-block.liquid`, add to the `<div class="tryme-tryon" ...>` attribute
list, after `data-product-image`:

```liquid
    {%- if customer -%}
      data-customer-id="{{ customer.id }}"
      data-customer-email="{{ customer.email }}"
    {%- endif -%}
```

This needs no OAuth scope and no Admin API call — `customer` is already
available in storefront Liquid. (Resolving a customer ID to an email through
the Admin API would need `read_customers`, which is both a scope change forcing
every merchant to re-consent and Shopify protected customer data.)

- [ ] **Step 2: Add the email-gate step markup**

In `tryon-block.liquid`, add a new step inside
`<div class="tryme-tryon__page tryme-tryon__page--main">`, immediately
after the `--ready` step block:

```liquid
            <div class="tryme-tryon__step tryme-tryon__step--email" hidden>
              <h2 class="tryme-tryon__upload-title">One quick thing</h2>
              <p class="tryme-tryon__upload-lead tryme-tryon__email-lead">
                Enter your email to continue.
              </p>
              <input
                type="email"
                class="tryme-tryon__email-input"
                placeholder="you@example.com"
                autocomplete="email"
                required
              />
              <label class="tryme-tryon__email-consent">
                <input type="checkbox" class="tryme-tryon__email-consent-input" />
                <span>Email me offers and updates from this store.</span>
              </label>
              <p class="tryme-tryon__email-error" hidden></p>
              <button type="button" class="tryme-tryon__email-submit">Continue</button>
            </div>
```

The consent checkbox is **unchecked by default** and must stay that way — a
pre-checked box is not valid GDPR consent.

- [ ] **Step 3: Mint and persist the anonymous client ID**

In `tryon-widget.js`, near the existing `HISTORY_STORAGE_KEY` declaration
(line ~48), add:

```js
    const CLIENT_ID_STORAGE_KEY = 'tryme_client_id';

    // One anonymous id per browser, minted once. This is a UX limiter, not a
    // security control: incognito, cleared storage, or a script all defeat it.
    // The store daily cap is what actually holds — see the design doc.
    function getClientId() {
      try {
        let id = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
        if (!id) {
          id = crypto.randomUUID();
          localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
        }
        return id;
      } catch (_err) {
        // Storage blocked (Safari private mode, etc.) — a per-call id still
        // lets the server create a row; it just won't persist across reloads.
        return crypto.randomUUID();
      }
    }

    const clientId = getClientId();
    const shopifyCustomerId = root.dataset.customerId
      ? Number(root.dataset.customerId)
      : undefined;
    // Prefill only. The server never trusts this for authorization.
    let shopperEmail = root.dataset.customerEmail || null;
    let shopperEmailConsent = false;
```

- [ ] **Step 4: Send identity on presign and job creation**

In `uploadPhoto`, change the presign body to:

```js
        body: JSON.stringify({ contentType: file.type, contentLength: file.size, clientId }),
```

In `createJob`, change the body to:

```js
        body: JSON.stringify({
          shopifyProductId: productId,
          customerPhotoKey: customerPhotoKey,
          clientId,
          ...(shopifyCustomerId ? { shopifyCustomerId } : {}),
          ...(shopperEmail ? { email: shopperEmail, emailConsent: shopperEmailConsent } : {}),
        }),
```

- [ ] **Step 5: Handle the refusal `reason` on 202**

In `createJob`, replace the existing `if (res.status === 202) return { pending: true };` with:

```js
      if (res.status === 202) {
        const body = await res.json().catch(() => ({}));
        return { pending: true, reason: body.reason, message: body.message };
      }
```

In `proceedWithPhoto`, replace the `if (jobResult.pending) { ... }` block with:

```js
        if (jobResult.pending) {
          showPage('main');
          if (jobResult.reason === 'email_required') {
            // Hold the photo key: the retry reuses the same upload (its Redis
            // ownership record lives 600s), so nothing is re-uploaded.
            awaitingEmailForPhotoKey = customerPhotoKey;
            showStep('email');
            return;
          }
          if (jobResult.message) {
            const pendingStep = steps.pending;
            if (pendingStep) pendingStep.querySelector('p').textContent = jobResult.message;
          }
          showStep('pending');
          return;
        }
```

- [ ] **Step 6: Wire the email form**

Add near the other element lookups (after the `steps` object), extending it
with the new step and its controls:

```js
    steps.email = root.querySelector('.tryme-tryon__step--email');
    const emailInput = root.querySelector('.tryme-tryon__email-input');
    const emailConsentInput = root.querySelector('.tryme-tryon__email-consent-input');
    const emailSubmit = root.querySelector('.tryme-tryon__email-submit');
    const emailError = root.querySelector('.tryme-tryon__email-error');
    let awaitingEmailForPhotoKey = null;

    if (emailInput && shopperEmail) emailInput.value = shopperEmail;

    if (emailSubmit) {
      emailSubmit.addEventListener('click', () => {
        const value = (emailInput && emailInput.value ? emailInput.value : '').trim();
        // Cheap client-side shape check only; the server's Zod schema is the
        // real validation.
        if (!value || value.indexOf('@') < 1) {
          if (emailError) {
            emailError.textContent = 'Enter a valid email address.';
            emailError.hidden = false;
          }
          return;
        }
        if (emailError) emailError.hidden = true;
        shopperEmail = value;
        shopperEmailConsent = !!(emailConsentInput && emailConsentInput.checked);
        const key = awaitingEmailForPhotoKey;
        awaitingEmailForPhotoKey = null;
        if (key) {
          showStep('progress');
          proceedWithPhoto(key, false);
        }
      });
    }
```

- [ ] **Step 7: Style the email step**

Append to `tryon-widget.css`:

```css
.tryme-tryon__email-input {
  width: 100%;
  padding: 12px 14px;
  margin: 12px 0 10px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: var(--tryme-border-radius, 4px);
  font-size: 15px;
  box-sizing: border-box;
}

.tryme-tryon__email-consent {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  margin-bottom: 12px;
}

.tryme-tryon__email-error {
  color: #b42318;
  font-size: 13px;
  margin: 0 0 10px;
}

.tryme-tryon__email-submit {
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-radius: var(--tryme-border-radius, 4px);
  background: var(--tryme-button-color, #000);
  color: var(--tryme-text-color, #fff);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
```

- [ ] **Step 8: Verify the extension bundle is valid**

Run: `node --check apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`
Expected: no output (syntax valid).

- [ ] **Step 9: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/
git commit -m "feat(shopify-extension): shopper client id, customer prefill, email gate

Anonymous client id per browser (UX limiter, not a security control), plus
Liquid customer id/email when the shopper is logged into the merchant's store
- free, no scope, no Admin API. The email gate reuses the already-uploaded
photo key on retry, so nothing is re-uploaded.

Consent checkbox is unchecked by default; a pre-checked box is not valid
GDPR consent."
```

---

### Task 7: Settings page — Limits tab

**Files:**
- Create: `apps/shopify/src/pages/SettingsPage.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppNavMenu.tsx:9-13`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: `PATCH /v1/shopify/settings` (Task 4); `GET /v1/shopify/me` `store.settings` (existing)
- Produces: `/settings` route; `NAV_ITEMS` gains a fourth entry

- [ ] **Step 1: Add the settings types**

In `apps/shopify/src/types.ts`, add and wire into `ShopifyMe['store']['settings']`:

```ts
export interface ShopifyStoreLimits {
  storeDailyCap?: number | null;
  perShopperCap?: number | null;
  perShopperWindow?: 'day' | 'week' | 'month';
  emailAfterNTryOns?: number | null;
}

export interface ShopifyStoreRetention {
  shopperPhotoDays?: number | null;
  resultDays?: number | null;
  shopperRecordDays?: number | null;
}
```

Add `limits?: ShopifyStoreLimits;` and `retention?: ShopifyStoreRetention;` to
the existing settings interface in that file.

- [ ] **Step 2: Add the nav entry**

In `apps/shopify/src/components/AppNavMenu.tsx`, import `SettingsIcon` from
`@shopify/polaris-icons` and add to `NAV_ITEMS` between Manage and Support:

```ts
  { path: '/settings', label: 'Settings', icon: SettingsIcon },
```

- [ ] **Step 3: Build the Settings page with the Limits tab**

Create `apps/shopify/src/pages/SettingsPage.tsx`:

```tsx
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  Select,
  SkeletonPage,
  Tabs,
  Text,
  Toast,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { ShopifyMe, ShopifyStoreLimits } from '../types';

const OFF = 'off';

// Mirrors the option sets in packages/types/src/widget.ts. Values outside these
// sets are rejected by the API with a 400.
const STORE_DAILY_CAP_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000];
const PER_SHOPPER_CAP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EMAIL_AFTER_N_OPTIONS = [0, 1, 2, 3, 5];

// The value the dropdown SHOWS when a merchant switches a limit on. It is not
// an enforced default: an absent setting means Off, so nothing changes for a
// store whose merchant never opens this page.
const PRESELECTED = { storeDailyCap: 250, perShopperCap: 5, emailAfterNTryOns: 2 };

function numericOptions(values: number[], offLabel: string, format: (n: number) => string) {
  return [{ label: offLabel, value: OFF }, ...values.map((n) => ({ label: format(n), value: String(n) }))];
}

export default function SettingsPage() {
  const [selectedTab, setSelectedTab] = useState(0);
  const [limits, setLimits] = useState<ShopifyStoreLimits>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((res) => {
        setLimits(res.store.settings.limits ?? {});
        setLoading(false);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/v1/shopify/settings', {
        method: 'PATCH',
        body: JSON.stringify({ limits }),
      });
      setToastMessage('Limits saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function setNumeric(key: keyof ShopifyStoreLimits, raw: string, preselected: number) {
    setLimits((prev) => ({
      ...prev,
      [key]: raw === OFF ? null : Number(raw) || preselected,
    }));
  }

  if (loading) return <SkeletonPage title="Settings" />;

  const tabs = [
    { id: 'limits', content: 'Limits' },
    { id: 'data', content: 'Data' },
  ];

  return (
    <Page title="Settings">
      <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
        <BlockStack gap="400">
          {error && (
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}

          {selectedTab === 0 && (
            <>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Store daily limit
                  </Text>
                  <Text as="p" tone="subdued">
                    The hard ceiling. Once this many try-ons have run today, the widget stops
                    generating until tomorrow — no matter who is asking. This is the only limit that
                    cannot be worked around from a browser.
                  </Text>
                  <Select
                    label="Try-ons per day"
                    options={numericOptions(
                      STORE_DAILY_CAP_OPTIONS,
                      'No limit',
                      (n) => `${n} per day`,
                    )}
                    value={limits.storeDailyCap == null ? OFF : String(limits.storeDailyCap)}
                    onChange={(v) => setNumeric('storeDailyCap', v, PRESELECTED.storeDailyCap)}
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Per-shopper limit
                  </Text>
                  <Text as="p" tone="subdued">
                    Reduces casual overuse by one shopper. Treat it as friction, not as a spend
                    guarantee — a shopper who clears their browser storage gets a fresh allowance.
                    Set a store daily limit as well if you want a hard ceiling.
                  </Text>
                  <Select
                    label="Try-ons per shopper"
                    options={numericOptions(PER_SHOPPER_CAP_OPTIONS, 'No limit', (n) => String(n))}
                    value={limits.perShopperCap == null ? OFF : String(limits.perShopperCap)}
                    onChange={(v) => setNumeric('perShopperCap', v, PRESELECTED.perShopperCap)}
                  />
                  <Select
                    label="Resets every"
                    options={[
                      { label: 'Day', value: 'day' },
                      { label: 'Week', value: 'week' },
                      { label: 'Month', value: 'month' },
                    ]}
                    value={limits.perShopperWindow ?? 'week'}
                    onChange={(v) =>
                      setLimits((prev) => ({
                        ...prev,
                        perShopperWindow: v as 'day' | 'week' | 'month',
                      }))
                    }
                    disabled={limits.perShopperCap == null}
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Ask for an email
                  </Text>
                  <Text as="p" tone="subdued">
                    After this many try-ons, shoppers are asked for their email before continuing.
                    Collected addresses appear under the Data tab.
                  </Text>
                  <Select
                    label="Ask after"
                    options={numericOptions(EMAIL_AFTER_N_OPTIONS, 'Never ask', (n) =>
                      n === 0 ? 'Before the first try-on' : `${n} try-on${n === 1 ? '' : 's'}`,
                    )}
                    value={
                      limits.emailAfterNTryOns == null ? OFF : String(limits.emailAfterNTryOns)
                    }
                    onChange={(v) =>
                      setNumeric('emailAfterNTryOns', v, PRESELECTED.emailAfterNTryOns)
                    }
                  />
                </BlockStack>
              </Card>

              <InlineStack align="end">
                <Button variant="primary" loading={saving} onClick={save}>
                  Save
                </Button>
              </InlineStack>
            </>
          )}

          {selectedTab === 1 && (
            <Card>
              <Text as="p" tone="subdued">
                Retention and collected emails appear here.
              </Text>
            </Card>
          )}
        </BlockStack>
      </Tabs>

      {toastMessage && <Toast content={toastMessage} onDismiss={() => setToastMessage(null)} />}
    </Page>
  );
}
```

The Data tab is filled in by Tasks 8 and 9.

- [ ] **Step 4: Register the route**

In `apps/shopify/src/App.tsx`, import `SettingsPage` and add the route beside
the others:

```tsx
          <Route path="/settings" element={<SettingsPage />} />
```

- [ ] **Step 5: Typecheck and build**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm --filter @tryme/shopify-admin build`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src/
git commit -m "feat(shopify): settings page with limits tab

Copy states plainly which limits are enforceable: the store daily cap is the
hard ceiling, the per-shopper cap is friction. A merchant who believes '5 per
shopper' protects their balance will be angry later.

Dropdown pre-selections are not enforced defaults - an absent setting means
Off, so nothing changes for a store whose merchant never opens this page."
```

---

### Task 8: Captured emails — list, export, Data tab

**Files:**
- Create: `apps/api/src/modules/shopify/shoppers.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `apps/shopify/src/pages/SettingsPage.tsx`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/api/test/integration/shopify-settings.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyShoppers`, `schema.jobs.shopifyShopperId` (Task 1)
- Produces:
  - `GET /v1/shopify/shoppers` → `{ items: ShopifyShopperListItem[] }`
  - `GET /v1/shopify/shoppers.csv` → `text/csv`
  - `ShopifyShopperListItem = { id, email, emailConsent, firstSeenAt, tryOnCount }`

- [ ] **Step 1: Write the failing integration test**

Append to `apps/api/test/integration/shopify-settings.test.ts`:

```ts
  it('lists only shoppers who gave an email, with consent and try-on count', async () => {
    await app.db.insert(schema.shopifyShoppers).values([
      { storeId, clientId: 'c-anon' },
      { storeId, clientId: 'c-mail', email: 'a@b.com', emailConsent: true },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/shoppers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: { email: string; emailConsent: boolean }[] };
    // Scoped to this test's own rows: the file shares one store across tests,
    // so an absolute count would break as soon as another test seeds a shopper.
    expect(items.find((i) => i.email === 'a@b.com')?.emailConsent).toBe(true);
    // The anonymous row must never appear — it exists for limit counting, and
    // is not a mailing-list entry.
    expect(items.some((i) => i.email == null)).toBe(false);
  });

  it('exports the same rows as CSV', async () => {
    await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId, clientId: 'c-csv', email: 'csv@b.com', emailConsent: false });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/shoppers.csv',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('email,consent,first_seen,try_ons');
    expect(res.body).toContain('csv@b.com,no,');
  });
```

These append to the file created in Task 4, so `storeId` and `token` are
already in scope from its `beforeAll`. The first test's `c-mail` row is also
what the second test's assertion tolerates — order the `.toHaveLength(1)`
assertion before inserting `c-csv`, or scope each test to a distinct email as
written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-settings.test.ts`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/modules/shopify/shoppers.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/** Only shoppers who actually supplied an email. Anonymous rows exist for
 *  limit counting and are not a mailing list. */
async function listShoppers(app: FastifyInstance, storeId: string) {
  return app.db
    .select({
      id: schema.shopifyShoppers.id,
      email: schema.shopifyShoppers.email,
      emailConsent: schema.shopifyShoppers.emailConsent,
      firstSeenAt: schema.shopifyShoppers.firstSeenAt,
      tryOnCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${schema.jobs}
        WHERE ${schema.jobs.shopifyShopperId} = ${schema.shopifyShoppers.id}
      )`,
    })
    .from(schema.shopifyShoppers)
    .where(
      and(
        eq(schema.shopifyShoppers.storeId, storeId),
        isNotNull(schema.shopifyShoppers.email),
      ),
    )
    .orderBy(desc(schema.shopifyShoppers.firstSeenAt));
}

/** RFC4180 minimal quoting. Emails cannot contain commas, but consent and
 *  dates are rendered here too and a stray quote must not corrupt the file. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function shopifyShoppersRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/shoppers', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
    return { items: await listShoppers(app, store.id) };
  });

  app.get(
    '/v1/shopify/shoppers.csv',
    { preHandler: app.requireShopifySession },
    async (req, reply) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const rows = await listShoppers(app, store.id);
      const lines = ['email,consent,first_seen,try_ons'];
      for (const r of rows) {
        lines.push(
          [
            csvCell(r.email ?? ''),
            r.emailConsent ? 'yes' : 'no',
            r.firstSeenAt.toISOString(),
            String(r.tryOnCount),
          ].join(','),
        );
      }
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="shoppers.csv"')
        .send(`${lines.join('\n')}\n`);
    },
  );
}
```

Register it in `apps/api/src/modules/shopify/routes.ts` the same way as Task 4
Step 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-settings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the email table to the Data tab**

In `apps/shopify/src/types.ts` add:

```ts
export interface ShopifyShopperListItem {
  id: string;
  email: string;
  emailConsent: boolean;
  firstSeenAt: string;
  tryOnCount: number;
}
```

In `SettingsPage.tsx`, add `IndexTable`, `EmptyState`, and `Badge` to the
Polaris import, plus state and a loader:

```tsx
  const [shoppers, setShoppers] = useState<ShopifyShopperListItem[] | null>(null);

  useEffect(() => {
    if (selectedTab !== 1 || shoppers) return;
    apiFetch<{ items: ShopifyShopperListItem[] }>('/v1/shopify/shoppers')
      .then((res) => setShoppers(res.items))
      .catch((err) => setError((err as Error).message));
  }, [selectedTab, shoppers]);
```

Replace the Data tab's placeholder `<Card>` with:

```tsx
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Collected emails
                  </Text>
                  <Button
                    url="/v1/shopify/shoppers.csv"
                    disabled={!shoppers || shoppers.length === 0}
                  >
                    Export CSV
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Only shoppers who ticked the consent box have agreed to marketing. Check the
                  Consent column before adding an address to a mailing list.
                </Text>
                {shoppers && shoppers.length === 0 ? (
                  <EmptyState heading="No emails collected yet" image="">
                    <p>Turn on "Ask for an email" under Limits to start collecting.</p>
                  </EmptyState>
                ) : (
                  <IndexTable
                    resourceName={{ singular: 'shopper', plural: 'shoppers' }}
                    itemCount={shoppers?.length ?? 0}
                    selectable={false}
                    loading={!shoppers}
                    headings={[
                      { title: 'Email' },
                      { title: 'Consent' },
                      { title: 'First seen' },
                      { title: 'Try-ons' },
                    ]}
                  >
                    {(shoppers ?? []).map((s, index) => (
                      <IndexTable.Row id={s.id} key={s.id} position={index}>
                        <IndexTable.Cell>{s.email}</IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone={s.emailConsent ? 'success' : undefined}>
                            {s.emailConsent ? 'Consented' : 'No consent'}
                          </Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {new Date(s.firstSeenAt).toLocaleDateString()}
                        </IndexTable.Cell>
                        <IndexTable.Cell>{String(s.tryOnCount)}</IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/shoppers.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/integration/shopify-settings.test.ts apps/shopify/src/
git commit -m "feat(shopify): captured email list and CSV export

Consent is a visible column, not a hidden field - the merchant needs to know
which addresses they may legally market to before pasting the list into an
email tool. Anonymous shopper rows exist for limit counting and are excluded."
```

---

### Task 9: Retention sweeper

**Files:**
- Create: `apps/dispatcher/src/shopify/retention.ts`
- Modify: `apps/dispatcher/src/index.ts:138-160`
- Create: `apps/api/test/integration/shopify-retention.test.ts`
- Modify: `apps/shopify/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `schema.shopifyShoppers`, `jobs.customerPhotoKey`, `jobOutputs.resultKey`/`thumbnailKey`, `ShopifyStoreRetention` (Task 1)
- Produces: `runShopifyRetention(db, storage, log): Promise<void>`

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/shopify-retention.test.ts`. It exercises the
dispatcher function directly against the API test harness's db + storage.

**Two cross-package wrinkles to expect:**

1. The relative import `../../../dispatcher/src/shopify/retention.js` reaches
   `apps/dispatcher/` from `apps/api/test/integration/`. If Vitest or `tsc`
   rejects it (no workspace dependency from api → dispatcher), move this file to
   `apps/dispatcher/test/integration/shopify-retention.test.ts` and stand up the
   containers there instead — do not add an api → dispatcher package
   dependency to make the import work.
2. `runShopifyRetention` takes `Logger` from `@tryme/logger`, and the test
   passes Fastify's `app.log`. Both are pino instances and structurally
   compatible; if TypeScript objects, pass `createLogger('test')` from
   `@tryme/logger` rather than widening the function's parameter type.

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runShopifyRetention } from '../../../dispatcher/src/shopify/retention.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('shopify retention sweeper', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  async function seedStoreWithRetention(retention: Record<string, unknown>) {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `ret-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() + Math.floor(Math.random() * 1000),
        accessToken: 'enc',
        scope: 'read_products',
        settings: { retention },
      })
      .returning();
    return store;
  }

  it('deletes an expired shopper photo but keeps the billing row', async () => {
    const store = await seedStoreWithRetention({ shopperPhotoDays: 7 });
    const key = `shopify-inputs/${store.id}/old/photo`;
    await app.storage.putObject(key, Buffer.from('x'), 'image/jpeg');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        customerPhotoKey: key,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(30),
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const [after] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after).toBeDefined();
    expect(after.creditsCharged).toBe(1);
    expect(after.customerPhotoKey).toBeNull();
    await expect(app.storage.headObject(key)).rejects.toThrow();
  });

  it('leaves everything alone when the merchant configured no retention', async () => {
    const store = await seedStoreWithRetention({});
    const key = `shopify-inputs/${store.id}/keep/photo`;
    await app.storage.putObject(key, Buffer.from('x'), 'image/jpeg');
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        customerPhotoKey: key,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(400),
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const [after] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after.customerPhotoKey).toBe(key);
  });

  it('deletes expired shopper records and nulls the job link without deleting the job', async () => {
    const store = await seedStoreWithRetention({ shopperRecordDays: 90 });
    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({
        storeId: store.id,
        clientId: 'old-client',
        email: 'old@example.com',
        lastSeenAt: daysAgo(200),
      })
      .returning();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        shopifyShopperId: shopper.id,
        creditsCharged: 1,
        source: 'shopify',
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const remaining = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(remaining).toHaveLength(0);

    const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(afterJob).toBeDefined();
    expect(afterJob.shopifyShopperId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-retention.test.ts`
Expected: FAIL — cannot resolve the retention module.

- [ ] **Step 3: Implement the sweeper**

Create `apps/dispatcher/src/shopify/retention.ts`:

```ts
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import type { StorageProvider } from '@tryme/storage';
import { and, eq, isNotNull, lt } from 'drizzle-orm';

// Bounded so one store with a long backlog cannot monopolise a pass. The
// sweeper runs hourly; anything left over is picked up next time.
const BATCH = 500;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Delete an R2 object, tolerating failure. One unreachable object must not
 *  wedge retention for an entire store — the next pass retries it. */
async function tryDelete(storage: StorageProvider, key: string, log: Logger): Promise<boolean> {
  try {
    await storage.deleteObject(key);
    return true;
  } catch (err) {
    log.warn({ err, key }, 'shopify retention: object delete failed, will retry next pass');
    return false;
  }
}

/**
 * Delete shopper PII past each store's configured retention.
 *
 * Never deletes a `jobs` row: it is a billing record tied to a credit
 * deduction and a ledger entry. Retention deletes the R2 objects and nulls the
 * key columns; the job, its cost, and its timestamp survive.
 *
 * Idempotent — a null key is skipped, so a crash mid-batch simply re-runs.
 */
export async function runShopifyRetention(
  db: DB,
  storage: StorageProvider,
  log: Logger,
): Promise<void> {
  const stores = await db.select().from(schema.shopifyStores);

  for (const store of stores) {
    const retention = store.settings?.retention;
    if (!retention) continue;

    if (retention.shopperPhotoDays != null) {
      const rows = await db
        .select({ id: schema.jobs.id, key: schema.jobs.customerPhotoKey })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.shopifyStoreId, store.id),
            isNotNull(schema.jobs.customerPhotoKey),
            lt(schema.jobs.createdAt, daysAgo(retention.shopperPhotoDays)),
          ),
        )
        .limit(BATCH);

      for (const row of rows) {
        if (!row.key) continue;
        if (!(await tryDelete(storage, row.key, log))) continue;
        await db
          .update(schema.jobs)
          .set({ customerPhotoKey: null })
          .where(eq(schema.jobs.id, row.id));
      }
      if (rows.length > 0) {
        log.info({ storeId: store.id, count: rows.length }, 'shopify retention: photos purged');
      }
    }

    if (retention.resultDays != null) {
      const rows = await db
        .select({
          jobId: schema.jobOutputs.jobId,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
        })
        .from(schema.jobOutputs)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobOutputs.jobId))
        .where(
          and(
            eq(schema.jobs.shopifyStoreId, store.id),
            isNotNull(schema.jobOutputs.resultKey),
            lt(schema.jobs.createdAt, daysAgo(retention.resultDays)),
          ),
        )
        .limit(BATCH);

      for (const row of rows) {
        if (row.resultKey) await tryDelete(storage, row.resultKey, log);
        if (row.thumbnailKey) await tryDelete(storage, row.thumbnailKey, log);
        await db
          .update(schema.jobOutputs)
          .set({ resultKey: null, thumbnailKey: null })
          .where(eq(schema.jobOutputs.jobId, row.jobId));
      }
      if (rows.length > 0) {
        log.info({ storeId: store.id, count: rows.length }, 'shopify retention: results purged');
      }
    }

    if (retention.shopperRecordDays != null) {
      // jobs.shopify_shopper_id is ON DELETE SET NULL, so this severs the link
      // without touching billing history.
      const deleted = await db
        .delete(schema.shopifyShoppers)
        .where(
          and(
            eq(schema.shopifyShoppers.storeId, store.id),
            lt(schema.shopifyShoppers.lastSeenAt, daysAgo(retention.shopperRecordDays)),
          ),
        )
        .returning({ id: schema.shopifyShoppers.id });
      if (deleted.length > 0) {
        log.info(
          { storeId: store.id, count: deleted.length },
          'shopify retention: shopper records purged',
        );
      }
    }
  }
}
```

- [ ] **Step 4: Wire the interval in the dispatcher**

In `apps/dispatcher/src/index.ts`, import:

```ts
import { runShopifyRetention } from './shopify/retention.js';
```

Add beside the existing intervals (after `sareeStep2Interval`):

```ts
  // Hourly: retention is a slow-moving daily-granularity policy, so a tighter
  // cadence would just re-scan stores with nothing to do.
  const shopifyRetentionInterval = setInterval(
    () => {
      void runShopifyRetention(db, storage, log);
    },
    60 * 60 * 1000,
  );
```

Add `clearInterval(shopifyRetentionInterval);` to the `shutdown` function
alongside the other `clearInterval` calls.

`storage` is already in scope — `index.ts:66` holds `const storage =
makeStorage(env);` (the same provider passed into `processorCfg` at line 118).
`db` and `log` are likewise already in scope from the existing `runSweeper`
call.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-retention.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the retention controls to the Data tab**

In `SettingsPage.tsx`, add retention state next to `limits`:

```tsx
  const [retention, setRetention] = useState<ShopifyStoreRetention>({});
```

Set it in `load()` from `res.store.settings.retention ?? {}`, and include it in
the `save()` payload: `body: JSON.stringify({ limits, retention })`.

Add a card at the top of the Data tab, above the emails card:

```tsx
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Automatic deletion
                </Text>
                <Text as="p" tone="subdued">
                  Shopper photos and generated images are deleted from storage on this schedule.
                  Try-on records used for billing are always kept. Note that deleting shopper
                  records also resets their limits — set it longer than your per-shopper window.
                </Text>
                <Select
                  label="Delete shopper photos after"
                  options={numericOptions([7, 30, 90], 'Keep forever', (n) => `${n} days`)}
                  value={
                    retention.shopperPhotoDays == null ? OFF : String(retention.shopperPhotoDays)
                  }
                  onChange={(v) =>
                    setRetention((p) => ({
                      ...p,
                      shopperPhotoDays: v === OFF ? null : Number(v),
                    }))
                  }
                />
                <Select
                  label="Delete generated images after"
                  options={numericOptions([30, 90, 180, 365], 'Keep forever', (n) => `${n} days`)}
                  value={retention.resultDays == null ? OFF : String(retention.resultDays)}
                  onChange={(v) =>
                    setRetention((p) => ({ ...p, resultDays: v === OFF ? null : Number(v) }))
                  }
                />
                <Select
                  label="Delete shopper records after"
                  options={numericOptions([90, 180, 365], 'Keep forever', (n) => `${n} days`)}
                  value={
                    retention.shopperRecordDays == null ? OFF : String(retention.shopperRecordDays)
                  }
                  onChange={(v) =>
                    setRetention((p) => ({
                      ...p,
                      shopperRecordDays: v === OFF ? null : Number(v),
                    }))
                  }
                />
                <InlineStack align="end">
                  <Button variant="primary" loading={saving} onClick={save}>
                    Save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
```

Import `ShopifyStoreRetention` from `../types`.

- [ ] **Step 7: Typecheck both packages**

Run: `pnpm --filter @tryme/dispatcher build && pnpm --filter @tryme/shopify-admin typecheck`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add apps/dispatcher/src/ apps/api/test/integration/shopify-retention.test.ts apps/shopify/src/pages/SettingsPage.tsx
git commit -m "feat(shopify): retention sweeper for shopper photos, results and records

Never deletes a jobs row - it is a billing record tied to a credit deduction.
Retention deletes the R2 objects and nulls the key columns. Failed object
deletes are logged and retried next pass rather than aborting the batch."
```

---

### Task 10: Make the GDPR webhooks real

**Files:**
- Create: `apps/api/src/modules/shopify/gdpr.ts`
- Modify: `apps/api/src/modules/shopify/webhook.routes.ts:88-95`
- Modify: `apps/api/test/integration/shopify-settings.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyShoppers` (Task 1)
- Produces:
  - `redactShopperData(app, storeId, match): Promise<number>`
  - `collectShopperData(app, storeId, match): Promise<{ shopperIds: string[]; emails: string[] }>`
  - `type ShopperMatch = { shopifyCustomerId?: number | null; email?: string | null }`

- [ ] **Step 1: Write the failing integration test**

Append to `apps/api/test/integration/shopify-settings.test.ts`:

```ts
  it('customers_redact deletes the matching shopper row', async () => {
    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({
        storeId,
        clientId: 'gdpr-client',
        shopifyCustomerId: 4242,
        email: 'redact@example.com',
      })
      .returning();

    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    const removed = await redactShopperData(app, storeId, {
      shopifyCustomerId: 4242,
      email: null,
    });

    expect(removed).toBe(1);
    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(rows).toHaveLength(0);
  });

  it('customers_redact also matches on email alone, for shoppers who never logged in', async () => {
    await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId, clientId: 'anon-mail', email: 'only-mail@example.com' });

    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    const removed = await redactShopperData(app, storeId, {
      shopifyCustomerId: null,
      email: 'only-mail@example.com',
    });
    expect(removed).toBe(1);
  });

  it('refuses to match anything when the payload identifies no subject', async () => {
    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    // An empty payload must never be read as "delete everything".
    expect(await redactShopperData(app, storeId, {})).toBe(0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-settings.test.ts`
Expected: FAIL — cannot resolve `gdpr.js`.

- [ ] **Step 3: Implement `gdpr.ts`**

Create `apps/api/src/modules/shopify/gdpr.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { normalizeEmail } from './shopper.js';

export interface ShopperMatch {
  shopifyCustomerId?: number | null;
  email?: string | null;
  /** shop_redact: every shopper for the store, ignoring the other fields. */
  matchAll?: boolean;
}

/** Match on customer id first, then email: a shopper may have supplied an
 *  email without ever logging in, and the webhook payload carries both.
 *  Returns null when nothing identifies a subject, so an empty payload can
 *  never be read as "match everything". */
function matchFilter(storeId: string, match: ShopperMatch) {
  const storeScope = eq(schema.shopifyShoppers.storeId, storeId);
  if (match.matchAll) return storeScope;

  const email = normalizeEmail(match.email);
  const clauses = [];
  if (match.shopifyCustomerId != null) {
    clauses.push(eq(schema.shopifyShoppers.shopifyCustomerId, match.shopifyCustomerId));
  }
  if (email) clauses.push(eq(schema.shopifyShoppers.email, email));
  if (clauses.length === 0) return null;
  return and(storeScope, or(...clauses));
}

/** Rows and stored R2 keys for a data-subject access request. */
export async function collectShopperData(
  app: FastifyInstance,
  storeId: string,
  match: ShopperMatch,
): Promise<{ shopperIds: string[]; emails: string[] }> {
  const filter = matchFilter(storeId, match);
  if (!filter) return { shopperIds: [], emails: [] };
  const rows = await app.db
    .select({ id: schema.shopifyShoppers.id, email: schema.shopifyShoppers.email })
    .from(schema.shopifyShoppers)
    .where(filter);
  return {
    shopperIds: rows.map((r) => r.id),
    emails: rows.map((r) => r.email).filter((e): e is string => !!e),
  };
}

/**
 * Erase a shopper: their R2 photos and results, then the row itself.
 *
 * jobs.shopify_shopper_id is ON DELETE SET NULL, so the billing rows survive
 * with the link severed. Returns the number of shopper rows removed.
 */
export async function redactShopperData(
  app: FastifyInstance,
  storeId: string,
  match: ShopperMatch,
): Promise<number> {
  const filter = matchFilter(storeId, match);
  if (!filter) return 0;

  const shoppers = await app.db
    .select({ id: schema.shopifyShoppers.id })
    .from(schema.shopifyShoppers)
    .where(filter);
  if (shoppers.length === 0) return 0;
  const ids = shoppers.map((s) => s.id);

  for (const shopperId of ids) {
    const jobRows = await app.db
      .select({ id: schema.jobs.id, photoKey: schema.jobs.customerPhotoKey })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.shopifyShopperId, shopperId), isNotNull(schema.jobs.id)));

    for (const job of jobRows) {
      if (job.photoKey) {
        try {
          await app.storage.deleteObject(job.photoKey);
        } catch (err) {
          app.log.warn({ err, jobId: job.id }, 'gdpr redact: photo delete failed');
        }
        await app.db
          .update(schema.jobs)
          .set({ customerPhotoKey: null })
          .where(eq(schema.jobs.id, job.id));
      }

      const [out] = await app.db
        .select()
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, job.id));
      if (out) {
        for (const key of [out.resultKey, out.thumbnailKey]) {
          if (!key) continue;
          try {
            await app.storage.deleteObject(key);
          } catch (err) {
            app.log.warn({ err, jobId: job.id }, 'gdpr redact: result delete failed');
          }
        }
        await app.db
          .update(schema.jobOutputs)
          .set({ resultKey: null, thumbnailKey: null })
          .where(eq(schema.jobOutputs.jobId, job.id));
      }
    }
  }

  await app.db.delete(schema.shopifyShoppers).where(filter);
  return ids.length;
}
```

- [ ] **Step 4: Replace the no-op webhook handlers**

In `apps/api/src/modules/shopify/webhook.routes.ts`, add the import:

```ts
import { collectShopperData, redactShopperData } from './gdpr.js';
```

Replace the `customers_redact` / `shop_redact` / `customers_data_request` cases
(lines ~88-95, including their now-false comments) with:

```ts
          case 'customers_redact': {
            if (store) {
              const removed = await redactShopperData(app, store.id, {
                shopifyCustomerId: payload.customer?.id ?? null,
                email: payload.customer?.email ?? null,
              });
              req.log.info({ topic, shopDomain, removed }, 'gdpr: shopper data redacted');
            }
            break;
          }
          case 'shop_redact': {
            if (store) {
              const removed = await redactShopperData(app, store.id, { matchAll: true });
              req.log.info({ topic, shopDomain, removed }, 'gdpr: store data purged');
            }
            break;
          }
          case 'customers_data_request': {
            if (store) {
              const found = await collectShopperData(app, store.id, {
                shopifyCustomerId: payload.customer?.id ?? null,
                email: payload.customer?.email ?? null,
              });
              // Shopify allows 30 days to respond and expects the merchant to
              // relay the data; log enough to fulfil it without dumping PII
              // into the log itself.
              req.log.info(
                { topic, shopDomain, shopperIds: found.shopperIds },
                'gdpr: data request received',
              );
            }
            break;
          }
```

`redactShopperData` already deletes each matched shopper's R2 objects before
deleting the rows, so `shop_redact` needs nothing beyond `matchAll: true`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-settings.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Verify no stale claims remain**

Run: `grep -n "no stored customer data\|store no customer PII" apps/api/src/modules/shopify/webhook.routes.ts`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/gdpr.ts apps/api/src/modules/shopify/webhook.routes.ts apps/api/test/integration/shopify-settings.test.ts
git commit -m "fix(shopify): make the GDPR webhooks actually erase data

customers_redact and customers_data_request were logging no-ops justified by
a comment claiming we store no shopper PII. Storing emails falsifies that, so
both now do real work: match on customer id then email (a shopper may have
given an email without ever logging in), delete R2 objects, delete the row.

jobs rows survive with shopify_shopper_id nulled - they are billing records."
```

---

### Task 11: Dashboard usage card

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts:39-70`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/api/test/shopify-me.test.ts`

**Interfaces:**
- Consumes: `storeDayKey`/`windowStart` (Task 3); `schema.shopifyShoppers` (Task 1)
- Produces: `ShopifyMe['stats']` gains `todayTryOns: number`, `storeDailyCap: number | null`, `capturedEmailCount: number`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shopify-me.test.ts` a case asserting the new stats
fields exist and count correctly:

```ts
  it('reports today usage against the store cap and the captured email count', async () => {
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { limits: { storeDailyCap: 100 } } })
      .where(eq(schema.shopifyStores.id, storeId));
    await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId, clientId: 'c1', email: 'a@b.com' });
    await app.db.insert(schema.jobs).values({
      status: 'COMPLETED',
      shopifyStoreId: storeId,
      creditsCharged: 1,
      source: 'shopify',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    expect(body.stats.storeDailyCap).toBe(100);
    expect(body.stats.todayTryOns).toBe(1);
    expect(body.stats.capturedEmailCount).toBe(1);
  });
```

`storeId` and `token` are already module-level in this file (set in its
`beforeAll`), and every other test there authenticates the same way — see
`apps/api/test/shopify-me.test.ts:88`. Drop the local `seedStore()` call and use
the shared `storeId`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-me`
Expected: FAIL — the three fields are undefined.

- [ ] **Step 3: Add the stats queries**

In `apps/api/src/modules/shopify/me.routes.ts`, import:

```ts
import { gte } from 'drizzle-orm';
import { windowStart } from './store-day.js';
```

Add before the `return` block:

```ts
    // Derived from Postgres, not the Redis cap counter: the merchant-facing
    // number must stay correct even if Redis has been flushed and the guard
    // has lost the day.
    const [{ todayTryOns }] = await app.db
      .select({ todayTryOns: count() })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.shopifyStoreId, store.id),
          gte(schema.jobs.createdAt, windowStart(store.ianaTimezone, 'day')),
        ),
      );

    const [{ capturedEmailCount }] = await app.db
      .select({ capturedEmailCount: count() })
      .from(schema.shopifyShoppers)
      .where(
        and(
          eq(schema.shopifyShoppers.storeId, store.id),
          sql`${schema.shopifyShoppers.email} IS NOT NULL`,
        ),
      );
```

Add to the returned `stats` object:

```ts
        todayTryOns,
        storeDailyCap: store.settings.limits?.storeDailyCap ?? null,
        capturedEmailCount,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-me`
Expected: PASS.

- [ ] **Step 5: Render the usage card**

In `apps/shopify/src/types.ts`, add the three fields to `ShopifyStats`.

In `DashboardPage.tsx`, add a card beside the existing credit balance card:

```tsx
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Today's try-ons
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.stats.storeDailyCap
                  ? `${me.stats.todayTryOns} / ${me.stats.storeDailyCap}`
                  : (me?.stats.todayTryOns ?? 0)}
              </Text>
              {me?.stats.storeDailyCap != null &&
                me.stats.todayTryOns >= me.stats.storeDailyCap && (
                  <Banner tone="warning">
                    Your daily limit is reached. Try-on is paused until tomorrow.
                  </Banner>
                )}
              <Text as="p" tone="subdued">
                {me?.stats.capturedEmailCount ?? 0} emails collected
              </Text>
            </BlockStack>
          </Card>
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm --filter @tryme/api typecheck`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/api/test/shopify-me.test.ts apps/shopify/src/
git commit -m "feat(shopify): dashboard usage card for daily cap and captured emails

Counts come from Postgres rather than the Redis cap counter, so the number the
merchant sees stays correct even if Redis has been flushed."
```

---

### Task 12: Widget dead-result handling, docs, full verification

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js` (history rendering)
- Modify: `docs/progress.md`

**Interfaces:**
- Consumes: everything above
- Produces: no new interface

- [ ] **Step 1: Hide history entries whose result was deleted**

Retention deletes result objects, so `localStorage` history entries pointing at
them will 404. In `tryon-widget.js`, inside `renderHistoryList()`, immediately
after the existing three lines that build the thumbnail:

```js
        const img = document.createElement('img');
        img.src = entry.resultUrl;
        img.alt = '';
```

insert:

```js
        // Retention may have deleted this result since it was cached locally.
        // A broken image is worse than a missing row, so drop the entry and
        // rewrite the stored history.
        img.addEventListener('error', () => {
          const remaining = getHistory().filter((h) => h.resultUrl !== entry.resultUrl);
          try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(remaining));
          } catch (_err) {
            // Storage blocked — the entry reappears next load; harmless.
          }
          renderHistoryList();
        });
```

`getHistory`, `HISTORY_STORAGE_KEY`, and `renderHistoryList` are all already
defined in this file (lines ~48, ~147, ~200).

- [ ] **Step 2: Verify widget syntax**

Run: `node --check apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`
Expected: no output.

- [ ] **Step 3: Run the full API unit suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS. Note any failures that also fail on `main` — `test/admin-dev-api.test.ts` is a known pre-existing flake in full-suite runs.

- [ ] **Step 4: Run the Shopify integration tests**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shopify-customer.test.ts test/integration/shopify-limits.test.ts test/integration/shopify-settings.test.ts test/integration/shopify-retention.test.ts`
Expected: all PASS. Run these four files together rather than the whole
integration suite — a shared real-Redis rate limiter is never reset between
files and causes a 429 cascade in unrelated suites (pre-existing, documented in
`docs/progress.md`).

- [ ] **Step 5: Typecheck and lint the workspace**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Update the progress log**

Add a new dated entry at the **top** of `docs/progress.md` following the
existing convention (Done / Failed–Not Done / Open Questions). It must record:

- **Done:** the shopper identity model, the three limits, email capture with
  consent, the Settings page, retention sweeper, real GDPR webhooks, dashboard
  usage card.
- **Failed / Not Done:** anything that did not pass; the pre-existing
  rate-limiter 429 cascade if encountered.
- **Open Questions / Decisions:**
  - Manual smoke test still required in a real Shopify admin iframe and a real
    storefront — the email gate and `<ui-nav-menu>` cannot be tested any other
    way.
  - Existing stores have `iana_timezone = NULL` until their next reinstall and
    fall back to UTC day boundaries.
  - Deferred: pushing captured emails into Shopify customer records
    (`write_customers` + protected-customer-data approval); App Proxy
    migration; merchant notification when a cap is hit.

- [ ] **Step 7: Commit**

```bash
git add apps/shopify-extension/ docs/progress.md
git commit -m "feat(shopify): drop dead history entries, log progress

Retention deletes result objects, so cached localStorage history entries can
404. A broken image is worse than a missing row - drop the entry and rewrite
the stored history."
```

---

## Verification Checklist

After all tasks, confirm:

- [ ] A store with no settings configured behaves exactly as before — no limits, no gate, no deletion.
- [ ] `GET /v1/shopify/me` reports `todayTryOns`, `storeDailyCap`, `capturedEmailCount`.
- [ ] A refused request deducts no credits and leaves the Redis counter unchanged.
- [ ] An anonymous → email identity upgrade does not reset the per-shopper count.
- [ ] `grep -rn "buttonText\|buttonColor\|customCss" apps/ packages/ --include=*.ts --include=*.tsx` returns nothing.
- [ ] `docs/progress.md` has a new dated entry at the top.
