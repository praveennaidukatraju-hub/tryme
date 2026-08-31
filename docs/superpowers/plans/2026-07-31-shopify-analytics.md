# Shopify Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merchants an Analytics page showing try-on usage over time, per-product try-ons and add-to-cart rate, a drop-off funnel, refusals, and captured-email counts — for a date range they choose.

**Architecture:** Most metrics are derived live from the existing `jobs` and `shopify_shoppers` tables; nothing is pre-aggregated. What does not exist today is any record of what a shopper does *outside* a generation, so a new append-only `shopify_widget_events` table plus a public storefront endpoint capture button clicks, uploads, result views, add-to-carts and shares. Events are advisory — no credit, limit, or authorization decision reads them — so the ingest path is allowed to drop writes under load rather than ever failing a shopper's try-on.

**Tech Stack:** Fastify 5 + Zod, Drizzle ORM, PostgreSQL 16 (`date_trunc … AT TIME ZONE`, `count(*) FILTER (WHERE …)`), Redis (rate limiting), React 18 + Polaris 13, hand-rolled inline SVG charts, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-shopify-analytics-design.md`

## Global Constraints

- All day boundaries are **store-local**, from `shopify_stores.iana_timezone` via `apps/api/src/modules/shopify/store-day.ts`. Never UTC.
- The rate card is named **"Add-to-cart rate"**, never "Conversion rate", in every label, type name, and API field.
- Events are **advisory**: no credit decision, limit check, or authorization may read `shopify_widget_events`.
- The ingest endpoint **never returns an error a shopper can feel**. Over-limit is a 204, not a 429.
- Analytics writes must never fail a shopper's request — every insert on a storefront path is wrapped so a failure logs and continues.
- Date ranges are capped at **400 days**, matching the events retention horizon.
- The funnel is **never clamped to be monotonic**.
- No `console.log` in committed code.
- ESM only, pnpm workspaces. Never introduce npm/yarn lockfiles.
- `pnpm docker:up` must be running before any integration test.
- `apps/admin-mobile` is out of scope.

---

## Spec Correction Applied In This Plan

**Refusal events are written in `customer.routes.ts`, not in `limits.ts`.** The spec says "three inserts in `limits.ts`". That does not survive contact with the code:

- `checkShopperLimits(db, store, shopper)` is called twice — once as a fast path before the transaction (`customer.routes.ts:327`), and again *inside* the job transaction via `lockAndRecheckShopperLimits` (`customer.routes.ts:350`). An insert inside `limits.ts` would fire twice for one refusal, and the second one would be rolled back when that path throws `ShopperLimitRaceRefusal`.
- The store-cap refusal is decided by `reserveStoreDailySlot`, which returns `{ ok: false }` and has no `db` handle at all.

The three points where a 202 is actually returned to the shopper are unambiguous and outside any transaction. That is where the events go.

---

## Dependencies

This plan runs **after** both:

1. `docs/superpowers/plans/2026-07-31-shopify-shopper-limits.md` — supplies `client_id`, `shopify_shoppers`, `limits.ts`, `store-day.ts`, and `apps/dispatcher/src/shopify/retention.ts`. As of writing, landed through roughly Task 9.
2. `docs/superpowers/plans/2026-07-31-shopify-widget-design.md` — supplies the Add to Cart button (without which `add_to_cart` can never fire), rewrites `tryon-widget.js`, replaces `tryon-block.liquid` with `tryon-button.liquid`, and adds the Vitest runner to `apps/shopify`.

Before starting, verify both:

```bash
ls apps/api/src/modules/shopify/limits.ts apps/dispatcher/src/shopify/retention.ts
ls apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid
grep -n '"test"' apps/shopify/package.json
```

If `tryon-button.liquid` is missing, the Widget Design plan has not landed — **stop and report**. Task 8 instruments a file that plan rewrites, and Task 9 relies on its Vitest setup.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/db/src/migrations/0135_shopify_widget_events.sql` | Events table, its three indexes, and the missing `jobs` index |
| `apps/api/src/modules/shopify/events.routes.ts` | `POST /v1/shopify/customer/event` — public ingest with its own rate limiter |
| `apps/api/src/modules/shopify/analytics.ts` | All aggregation queries. No HTTP concerns |
| `apps/api/src/modules/shopify/analytics.routes.ts` | `GET /v1/shopify/analytics` — range parsing, validation, response assembly |
| `apps/api/test/shopify-events.test.ts` | Ingest endpoint behaviour |
| `apps/api/test/shopify-refusal-events.test.ts` | Refusals produce server-written events |
| `apps/api/test/shopify-analytics.test.ts` | Every metric, timezone bucketing, store isolation |
| `apps/dispatcher/test/integration/shopify-events-retention.test.ts` | Events retention pass |
| `apps/shopify/src/lib/analyticsRange.ts` | Preset → `from`/`to` resolution. Pure, unit-tested |
| `apps/shopify/src/lib/analyticsRange.test.ts` | Unit tests for the resolver |
| `apps/shopify/src/components/BarChart.tsx` | One SVG bar primitive, vertical and horizontal |
| `apps/shopify/src/components/ChartTable.tsx` | Accessible table view shared by both charts |
| `apps/shopify/src/pages/AnalyticsPage.tsx` | The page — range control, KPI tiles, charts, product table |

**Modified**

| File | Change |
|---|---|
| `packages/db/src/schema/shopify.ts` | `shopifyWidgetEvents` table |
| `packages/db/src/schema/jobs.ts` | Index block on `(shopify_store_id, created_at)` |
| `packages/db/src/migrations/meta/_journal.json` | Entry idx 135 |
| `packages/types/src/widget.ts` | Event and analytics-query Zod schemas, event-type constants |
| `apps/api/src/modules/shopify/store-day.ts` | Export `localDayStart` |
| `apps/api/src/modules/shopify/customer.routes.ts` | Record refusal events at the three 202 sites |
| `apps/api/src/modules/shopify/routes.ts` | Register two new route modules |
| `apps/dispatcher/src/shopify/retention.ts` | Fourth pass — events past 400 days |
| `.../assets/tryon-widget.js` | `trackEvent` helper and five fire points |
| `apps/shopify/src/types.ts` | Analytics response types |
| `apps/shopify/src/App.tsx` | `/analytics` route |
| `apps/shopify/src/components/AppNavMenu.tsx` | Nav entry |

---

## Task 1: Events table, indexes, and migration

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Modify: `packages/db/src/schema/jobs.ts:20-61`
- Create: `packages/db/src/migrations/0135_shopify_widget_events.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `shopifyStores` from the same schema file.
- Produces: `schema.shopifyWidgetEvents` with columns `id`, `storeId`, `clientId`, `shopifyProductId`, `type`, `device`, `createdAt`.

- [ ] **Step 1: Add the table to the schema**

In `packages/db/src/schema/shopify.ts`, add `bigserial` to the existing
`drizzle-orm/pg-core` import list, then append this table at the end of the file:

```ts
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
```

- [ ] **Step 2: Add the missing jobs index**

`packages/db/src/schema/jobs.ts` declares `jobs` with no second argument, so it
has no indexes beyond its primary key and foreign keys. Every analytics query
filters on `(shopify_store_id, created_at)` together. Add `index` to the
`drizzle-orm/pg-core` import in that file, then change the closing of the `jobs`
table from:

```ts
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
```

to:

```ts
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    // Every Shopify analytics query filters on exactly this pair. Without it
    // each one degrades to a sequential scan of every job in the system.
    byShopifyStoreTime: index('jobs_shopify_store_created_idx').on(
      t.shopifyStoreId,
      t.createdAt,
    ),
  }),
);
```

Note the body of the column object must be re-indented one level, and the
opening line becomes `export const jobs = pgTable('jobs', {`.

- [ ] **Step 3: Write the migration**

Create `packages/db/src/migrations/0135_shopify_widget_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS "shopify_widget_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "store_id" uuid NOT NULL,
  "client_id" text,
  "shopify_product_id" bigint,
  "type" text NOT NULL,
  "device" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_widget_events" ADD CONSTRAINT "shopify_widget_events_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_widget_events_store_time_idx" ON "shopify_widget_events" ("store_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_widget_events_store_type_time_idx" ON "shopify_widget_events" ("store_id","type","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_widget_events_store_product_time_idx" ON "shopify_widget_events" ("store_id","shopify_product_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_shopify_store_created_idx" ON "jobs" ("shopify_store_id","created_at");
```

- [ ] **Step 4: Register it in the journal**

In `packages/db/src/migrations/meta/_journal.json`, append an entry after idx
134, matching the shape of the existing entries:

```json
{
  "idx": 135,
  "version": "7",
  "when": 1785000000000,
  "tag": "0135_shopify_widget_events",
  "breakpoints": true
}
```

Copy the `version` value from the idx-134 entry rather than trusting `"7"` — it
must match what the installed drizzle-kit writes.

- [ ] **Step 5: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: succeeds. A NOTICE about an object already existing is safe.

Then confirm the table is real:

```bash
psql "$DATABASE_URL" -c "\d shopify_widget_events"
```

Expected: four indexes listed (primary key plus the three named above).

**Never run this against production or `tryon_prod`** — local or staging only,
per `CLAUDE.md`.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/schema/jobs.ts \
        packages/db/src/migrations/0135_shopify_widget_events.sql \
        packages/db/src/migrations/meta/_journal.json
git commit -m "feat(shopify): add widget events table and jobs analytics index"
```

---

## Task 2: Event ingest endpoint

**Files:**
- Modify: `packages/types/src/widget.ts` (append)
- Create: `apps/api/src/modules/shopify/events.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Test: `apps/api/test/shopify-events.test.ts` (create)

**Interfaces:**
- Consumes: `schema.shopifyWidgetEvents` from Task 1; `app.requireShopifyStoreKey` (sets `req.shopifyStoreId`).
- Produces:
  - `SHOPIFY_CLIENT_EVENT_TYPES`, `SHOPIFY_REFUSAL_EVENT_TYPES`, `ShopifyWidgetEventRequest` from `@tryme/types`
  - `shopifyEventsRoutes(app: FastifyInstance)`
  - `POST /v1/shopify/customer/event` → always 204, no body

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-events.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
let c: Containers;
let app: TestApp;
let storeId: string;
let storeKey: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 91,
      shopDomain: 'ev.myshopify.com',
      myshopifyDomain: 'ev.myshopify.com',
      name: 'EV',
      email: 'ev@ev.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  storeKey = store.storeKey;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

function post(payload: unknown, key: string | null = storeKey) {
  return app.inject({
    method: 'POST',
    url: '/v1/shopify/customer/event',
    headers: key ? { 'x-widget-key': key } : {},
    payload,
  });
}

async function events() {
  return app.db
    .select()
    .from(schema.shopifyWidgetEvents)
    .where(eq(schema.shopifyWidgetEvents.storeId, storeId));
}

describe('POST /v1/shopify/customer/event', () => {
  it('records a client event and answers 204', async () => {
    const clientId = randomUUID();
    const res = await post({
      type: 'add_to_cart',
      clientId,
      shopifyProductId: 555,
      device: 'mobile',
    });

    expect(res.statusCode).toBe(204);
    const rows = await events();
    const row = rows.find((r) => r.clientId === clientId);
    expect(row).toMatchObject({
      type: 'add_to_cart',
      shopifyProductId: 555,
      device: 'mobile',
    });
  });

  it('accepts a payload with no clientId', async () => {
    const res = await post({ type: 'button_click' });
    expect(res.statusCode).toBe(204);
  });

  it('rejects a missing store key', async () => {
    const res = await post({ type: 'button_click' }, null);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown event type', async () => {
    const res = await post({ type: 'nonsense' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a server-only refusal type submitted by a client', async () => {
    // Otherwise a shopper could manufacture refusals that never happened and
    // make a merchant think their caps are costing them traffic.
    const res = await post({ type: 'refused_store_cap' });
    expect(res.statusCode).toBe(400);
  });

  it('drops events over the rate limit with a 204 and writes nothing', async () => {
    // A 429 would surface in the widget's hot path. Analytics is allowed to
    // lose data; a shopper's try-on is not allowed to break.
    await app.redis.set(`shopify:events:rl:${storeId}`, '99999', 'EX', 60);
    const before = (await events()).length;

    const res = await post({ type: 'share', clientId: randomUUID() });

    expect(res.statusCode).toBe(204);
    expect((await events()).length).toBe(before);
    await app.redis.del(`shopify:events:rl:${storeId}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-events`
Expected: FAIL — every request 404s, the route does not exist.

- [ ] **Step 3: Add the schemas**

Append to `packages/types/src/widget.ts`:

```ts
/**
 * Event types the storefront widget may report. Deliberately excludes the
 * `refused_*` types: those are written server-side where the refusal is
 * actually decided, and accepting them from a client would let a shopper
 * fabricate the "shoppers you turned away" number a merchant acts on.
 */
export const SHOPIFY_CLIENT_EVENT_TYPES = [
  'button_click',
  'upload',
  'result_view',
  'add_to_cart',
  'share',
] as const;

export const SHOPIFY_REFUSAL_EVENT_TYPES = [
  'refused_store_cap',
  'refused_shopper_cap',
  'refused_email_gate',
] as const;

export const ShopifyWidgetEventRequest = z.object({
  type: z.enum(SHOPIFY_CLIENT_EVENT_TYPES),
  clientId: z.string().uuid().optional(),
  shopifyProductId: z.number().int().positive().optional(),
  device: z.enum(['mobile', 'desktop']).optional(),
});
export type ShopifyWidgetEventRequest = z.infer<typeof ShopifyWidgetEventRequest>;
```

- [ ] **Step 4: Implement the route**

Create `apps/api/src/modules/shopify/events.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { ShopifyWidgetEventRequest } from '@tryme/types';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';

// Far higher than the 60/min per store that customer.routes.ts applies to job
// creation: one busy store legitimately produces hundreds of events a minute,
// and this endpoint costs a single insert rather than a generation.
const EVENTS_PER_MINUTE = 600;

/** @returns true when this event is within budget and should be stored. */
async function withinEventBudget(redis: Redis, storeId: string): Promise<boolean> {
  const key = `shopify:events:rl:${storeId}`;
  const [[, used], [, ttl]] = (await redis.pipeline().incr(key).ttl(key).exec()) as [
    [null, number],
    [null, number],
  ];
  if (ttl === -1) await redis.expire(key, 60);
  return used <= EVENTS_PER_MINUTE;
}

export async function shopifyEventsRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/customer/event',
    {
      preValidation: app.requireShopifyStoreKey,
      schema: { body: ShopifyWidgetEventRequest },
    },
    async (req, reply) => {
      const storeId = req.shopifyStoreId as string;
      const body = req.body as ShopifyWidgetEventRequest;

      // Everything below is best-effort. This endpoint sits in the widget's hot
      // path, and a shopper must never see a failure caused by our bookkeeping
      // — so an over-budget event and a broken database look identical from the
      // storefront: 204, nothing stored.
      try {
        if (await withinEventBudget(app.redis, storeId)) {
          await app.db.insert(schema.shopifyWidgetEvents).values({
            storeId,
            clientId: body.clientId ?? null,
            shopifyProductId: body.shopifyProductId ?? null,
            type: body.type,
            device: body.device ?? null,
          });
        }
      } catch (err) {
        req.log.warn({ err, storeId }, 'shopify widget event dropped');
      }

      return reply.code(204).send();
    },
  );
}
```

- [ ] **Step 5: Register the route**

In `apps/api/src/modules/shopify/routes.ts`, add the import alongside the others:

```ts
import { shopifyEventsRoutes } from './events.routes.js';
```

and register it after `shopifySettingsRoutes`:

```ts
  await app.register(shopifyEventsRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-events`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/shopify/events.routes.ts \
        apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-events.test.ts
git commit -m "feat(shopify): public widget event ingest endpoint"
```

---

## Task 3: Record refusal events

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts:327-337`
- Test: `apps/api/test/shopify-refusal-events.test.ts` (create)

**Interfaces:**
- Consumes: `schema.shopifyWidgetEvents` (Task 1); `SHOPIFY_REFUSAL_EVENT_TYPES` (Task 2); the existing `LimitRefusal` type from `./limits.js`.
- Produces: `recordRefusal(app: FastifyInstance, storeId: string, reason: LimitRefusal['reason'], clientId: string | null, shopifyProductId: number | null): Promise<void>` — a local helper in `customer.routes.ts`, not exported.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-refusal-events.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
let c: Containers;
let app: TestApp;
let storeId: string;
let storeKey: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 92,
      shopDomain: 'rf.myshopify.com',
      myshopifyDomain: 'rf.myshopify.com',
      name: 'RF',
      email: 'rf@rf.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  storeKey = store.storeKey;

  // A cap of zero refuses every request, which is the cheapest way to reach the
  // store_limit branch without seeding a day's worth of jobs.
  await app.db
    .update(schema.shopifyStores)
    .set({ settings: { limits: { storeDailyCap: 0 } } })
    .where(eq(schema.shopifyStores.id, storeId));
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('refusals are recorded as server-written events', () => {
  it('writes refused_store_cap when the store daily cap turns a shopper away', async () => {
    const clientId = randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': storeKey },
      payload: {
        customerPhotoKey: 'shopify-customer/whatever.jpg',
        shopifyProductId: 4242,
        clientId,
      },
    });

    // Soft refusal: the shopper gets a 202 with a reason, never an error.
    expect(res.statusCode).toBe(202);
    expect(res.json().reason).toBe('store_limit');

    const rows = await app.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(
        and(
          eq(schema.shopifyWidgetEvents.storeId, storeId),
          eq(schema.shopifyWidgetEvents.type, 'refused_store_cap'),
        ),
      );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]).toMatchObject({
      clientId,
      shopifyProductId: 4242,
    });
  });
});
```

If the route rejects before reaching the cap check — for example because the
product is not an enabled garment — seed a `shopify_product_garments` row for
product 4242 with `status: 'active'` and `enabled: true` first, copying the seed
helper from `apps/api/test/integration/shopify-customer.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-refusal-events`
Expected: FAIL — `rows.length` is 0; the refusal is returned but not recorded.

- [ ] **Step 3: Add the helper**

In `apps/api/src/modules/shopify/customer.routes.ts`, add near the other
module-level helpers (below `checkRateLimit`):

```ts
/**
 * Record a refusal the shopper actually saw.
 *
 * Deliberately NOT inside limits.ts, despite the design doc suggesting it:
 * `checkShopperLimits` runs twice per request — once as a fast path and again
 * inside the job transaction via `lockAndRecheckShopperLimits` — so an insert
 * there would double-count, and the transactional call rolls back on refusal
 * anyway. `reserveStoreDailySlot` has no db handle at all. The three points
 * where a 202 reaches the shopper are unambiguous, and this is called from
 * exactly those.
 *
 * Best-effort: a failed analytics write must never turn a soft refusal into a
 * 500.
 */
const REFUSAL_EVENT_TYPE: Record<LimitRefusal['reason'], string> = {
  email_required: 'refused_email_gate',
  shopper_limit: 'refused_shopper_cap',
  store_limit: 'refused_store_cap',
};

async function recordRefusal(
  app: FastifyInstance,
  storeId: string,
  reason: LimitRefusal['reason'],
  clientId: string | null,
  shopifyProductId: number | null,
): Promise<void> {
  try {
    await app.db.insert(schema.shopifyWidgetEvents).values({
      storeId,
      clientId,
      shopifyProductId,
      type: REFUSAL_EVENT_TYPE[reason],
    });
  } catch (err) {
    app.log.warn({ err, storeId, reason }, 'shopify refusal event not recorded');
  }
}
```

Add `LimitRefusal` to the existing import from `./limits.js`:

```ts
import {
  checkShopperLimits,
  type LimitRefusal,
  lockAndRecheckShopperLimits,
  reserveStoreDailySlot,
} from './limits.js';
```

- [ ] **Step 4: Call it at the two refusal sites**

At `customer.routes.ts:327-329`, change:

```ts
        const refusal = await checkShopperLimits(app.db, store, shopper);
        if (refusal) return reply.code(202).send(refusal);
```

to:

```ts
        const refusal = await checkShopperLimits(app.db, store, shopper);
        if (refusal) {
          await recordRefusal(app, storeId, refusal.reason, clientId ?? null, shopifyProductId);
          return reply.code(202).send(refusal);
        }
```

At `customer.routes.ts:331-337`, change:

```ts
      const slot = await reserveStoreDailySlot(app, store);
      if (!slot.ok) {
        return reply
          .code(202)
          .send({ reason: 'store_limit', message: "Try-on isn't available right now." });
      }
```

to:

```ts
      const slot = await reserveStoreDailySlot(app, store);
      if (!slot.ok) {
        await recordRefusal(app, storeId, 'store_limit', clientId ?? null, shopifyProductId);
        return reply
          .code(202)
          .send({ reason: 'store_limit', message: "Try-on isn't available right now." });
      }
```

- [ ] **Step 5: Handle the race-path refusal**

`lockAndRecheckShopperLimits` throws `ShopperLimitRaceRefusal` from inside the
transaction. Find the `catch` that converts it into a 202 and add the same call
there, **after** the transaction has rolled back so the insert is not undone:

```ts
        if (err instanceof ShopperLimitRaceRefusal) {
          await recordRefusal(
            app,
            storeId,
            err.refusal.reason,
            clientId ?? null,
            shopifyProductId,
          );
          return reply.code(202).send(err.refusal);
        }
```

If that catch does not exist in the current code, the race path is handled
elsewhere — search for `ShopperLimitRaceRefusal` in the file and add the call at
whichever site returns its 202.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-refusal-events`
Expected: PASS.

Then confirm nothing regressed in the limits behaviour:

Run: `pnpm --filter @tryme/api test -- shopify-limits`
Expected: PASS (this file comes from the shopper-limits plan).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts \
        apps/api/test/shopify-refusal-events.test.ts
git commit -m "feat(shopify): record shopper refusals as analytics events"
```

---

## Task 4: Store-local range helper, cards, and daily series

**Files:**
- Modify: `apps/api/src/modules/shopify/store-day.ts`
- Create: `apps/api/src/modules/shopify/analytics.ts`
- Test: `apps/api/test/shopify-analytics.test.ts` (create)

**Interfaces:**
- Consumes: `schema.shopifyWidgetEvents` (Task 1); existing `schema.jobs`, `schema.shopifyShoppers`.
- Produces:
  - `localDayStart(timezone: string | null, isoDate: string): Date` from `./store-day.js`
  - `AnalyticsRange { from: Date; to: Date; timezone: string }`
  - `AnalyticsCards { tryOns, uniqueShoppers, addedToCart, addToCartRate, emailsCaptured, turnedAway: { total, storeCap, shopperCap, emailGate } }`
  - `analyticsCards(db: DB, storeId: string, range: AnalyticsRange): Promise<AnalyticsCards>`
  - `analyticsDaily(db: DB, storeId: string, range: AnalyticsRange): Promise<{ day: string; tryOns: number }[]>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-analytics.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { analyticsCards, analyticsDaily } from '../src/modules/shopify/analytics.js';
import { localDayStart } from '../src/modules/shopify/store-day.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const TZ = 'Asia/Kolkata'; // UTC+5:30 — a half-hour offset catches naive UTC math
let c: Containers;
let app: TestApp;
let storeId: string;
let otherStoreId: string;
let userId: string;

const range = {
  from: localDayStart(TZ, '2026-07-01'),
  to: localDayStart(TZ, '2026-07-08'),
  timezone: TZ,
};

async function seedShopper(store: string, clientId: string, email: string | null = null) {
  const [row] = await app.db
    .insert(schema.shopifyShoppers)
    .values({ storeId: store, clientId, email, emailCapturedAt: email ? new Date('2026-07-02T10:00:00Z') : null })
    .returning();
  return row.id;
}

async function seedJob(store: string, shopperId: string | null, at: string, productId?: number) {
  const jobId = randomUUID();
  await app.db.insert(schema.jobs).values({
    id: jobId,
    userId,
    shopifyStoreId: store,
    shopifyShopperId: shopperId,
    status: 'COMPLETED',
    source: 'shopify',
    createdAt: new Date(at),
  });
  if (productId != null) {
    await app.db.insert(schema.jobInputs).values({
      jobId,
      params: { kind: 'shopify', shopifyProductId: productId },
    });
  }
  return jobId;
}

async function seedEvent(store: string, type: string, clientId: string | null, at: string, productId?: number) {
  await app.db.insert(schema.shopifyWidgetEvents).values({
    storeId: store,
    type,
    clientId,
    shopifyProductId: productId ?? null,
    createdAt: new Date(at),
  });
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY });

  const [user] = await app.db
    .insert(schema.users)
    .values({ email: `an-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
    .returning();
  userId = user.id;

  const store = await upsertShopifyStore(
    app,
    { shopifyShopId: 93, shopDomain: 'an.myshopify.com', myshopifyDomain: 'an.myshopify.com', name: 'AN', email: 'a@a.com' },
    'tok',
    'read_products',
  );
  storeId = store.id;
  await app.db
    .update(schema.shopifyStores)
    .set({ ianaTimezone: TZ })
    .where(eq(schema.shopifyStores.id, storeId));

  const other = await upsertShopifyStore(
    app,
    { shopifyShopId: 94, shopDomain: 'ot.myshopify.com', myshopifyDomain: 'ot.myshopify.com', name: 'OT', email: 'o@o.com' },
    'tok',
    'read_products',
  );
  otherStoreId = other.id;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('analyticsCards', () => {
  it('counts try-ons, shoppers, add-to-carts and emails in range', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const s1 = await seedShopper(storeId, c1, 'a@b.com');
    const s2 = await seedShopper(storeId, c2);

    await seedJob(storeId, s1, '2026-07-02T06:00:00Z');
    await seedJob(storeId, s1, '2026-07-03T06:00:00Z');
    await seedJob(storeId, s2, '2026-07-04T06:00:00Z');
    await seedJob(storeId, null, '2026-07-04T07:00:00Z'); // no shopper identity

    // Three clicks from one shopper is one converted shopper, not three.
    await seedEvent(storeId, 'add_to_cart', c1, '2026-07-02T07:00:00Z');
    await seedEvent(storeId, 'add_to_cart', c1, '2026-07-02T07:01:00Z');
    await seedEvent(storeId, 'add_to_cart', c1, '2026-07-02T07:02:00Z');

    await seedEvent(storeId, 'refused_store_cap', c2, '2026-07-05T06:00:00Z');
    await seedEvent(storeId, 'refused_email_gate', c2, '2026-07-05T06:01:00Z');

    const cards = await analyticsCards(app.db, storeId, range);

    expect(cards.tryOns).toBe(4);
    expect(cards.uniqueShoppers).toBe(2);
    expect(cards.addedToCart).toBe(1);
    expect(cards.emailsCaptured).toBe(1);
    expect(cards.turnedAway).toMatchObject({ total: 2, storeCap: 1, emailGate: 1, shopperCap: 0 });
    // Denominator is shoppers with an identity (2), not the try-on count (4).
    expect(cards.addToCartRate).toBeCloseTo(0.5, 5);
  });

  it('never counts another store', async () => {
    const c3 = randomUUID();
    const s3 = await seedShopper(otherStoreId, c3);
    await seedJob(otherStoreId, s3, '2026-07-02T06:00:00Z');
    await seedEvent(otherStoreId, 'add_to_cart', c3, '2026-07-02T07:00:00Z');

    const cards = await analyticsCards(app.db, storeId, range);
    expect(cards.tryOns).toBe(4);
    expect(cards.addedToCart).toBe(1);
  });

  it('excludes activity outside the range', async () => {
    const c4 = randomUUID();
    const s4 = await seedShopper(storeId, c4);
    await seedJob(storeId, s4, '2026-06-30T06:00:00Z');
    await seedJob(storeId, s4, '2026-07-20T06:00:00Z');

    const cards = await analyticsCards(app.db, storeId, range);
    expect(cards.tryOns).toBe(4);
  });
});

describe('analyticsDaily', () => {
  it('buckets by store-local day and zero-fills quiet days', async () => {
    const daily = await analyticsDaily(app.db, storeId, range);

    // 2026-07-01 .. 2026-07-07 inclusive — the range is half-open on `to`.
    expect(daily.map((d) => d.day)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
    ]);
    expect(daily.find((d) => d.day === '2026-07-01')?.tryOns).toBe(0);
    expect(daily.find((d) => d.day === '2026-07-04')?.tryOns).toBe(2);
  });

  it('assigns a job to the store-local day, not the UTC day', async () => {
    const c5 = randomUUID();
    const s5 = await seedShopper(storeId, c5);
    // 20:00 UTC on the 5th is 01:30 on the 6th in Asia/Kolkata.
    await seedJob(storeId, s5, '2026-07-05T20:00:00Z');

    const daily = await analyticsDaily(app.db, storeId, range);
    expect(daily.find((d) => d.day === '2026-07-06')?.tryOns).toBe(1);
    expect(daily.find((d) => d.day === '2026-07-05')?.tryOns).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-analytics`
Expected: FAIL — `analytics.js` and `localDayStart` do not exist.

- [ ] **Step 3: Export `localDayStart`**

`store-day.ts` already computes local midnight internally for `windowStart`.
Append an exported wrapper so the analytics range can be built from an arbitrary
calendar date rather than only "now":

```ts
/**
 * The UTC instant at which the given store-local calendar date begins.
 *
 * `isoDate` is a bare YYYY-MM-DD naming a day in the store's own timezone —
 * which is what the Analytics page sends. Parsing it as a UTC timestamp instead
 * would shift every bucket by the store's offset and silently misattribute
 * activity near midnight.
 */
export function localDayStart(timezone: string | null, isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return localMidnightUtc(validTimezone(timezone), year, month, day);
}
```

`localMidnightUtc` and `validTimezone` already exist in that file as
module-private helpers — no change needed to them.

- [ ] **Step 4: Implement cards and the daily series**

Create `apps/api/src/modules/shopify/analytics.ts`:

```ts
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';

export interface AnalyticsRange {
  /** Inclusive UTC instant of the first store-local day. */
  from: Date;
  /** Exclusive UTC instant — the start of the day AFTER the last one shown. */
  to: Date;
  timezone: string;
}

export interface AnalyticsCards {
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  /** 0..1. Named add-to-cart, never "conversion" — it is not a sale. */
  addToCartRate: number;
  emailsCaptured: number;
  turnedAway: { total: number; storeCap: number; shopperCap: number; emailGate: number };
}

const int = (expr: ReturnType<typeof sql>) => sql<number>`${expr}::int`;

export async function analyticsCards(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<AnalyticsCards> {
  const inJobRange = and(
    eq(schema.jobs.shopifyStoreId, storeId),
    gte(schema.jobs.createdAt, range.from),
    lt(schema.jobs.createdAt, range.to),
  );

  const [jobRow] = await db
    .select({
      tryOns: int(sql`count(*)`),
      uniqueShoppers: int(sql`count(distinct ${schema.jobs.shopifyShopperId})`),
    })
    .from(schema.jobs)
    .where(inJobRange);

  // The add-to-cart denominator. NOT `tryOns`: that counts jobs and includes
  // shoppers with no client_id, so dividing a client-id-keyed numerator by it
  // would understate the rate for every store still serving old widget builds.
  const [identifiedRow] = await db
    .select({
      n: int(sql`count(distinct ${schema.shopifyShoppers.clientId})`),
    })
    .from(schema.jobs)
    .innerJoin(
      schema.shopifyShoppers,
      eq(schema.jobs.shopifyShopperId, schema.shopifyShoppers.id),
    )
    .where(inJobRange);

  const ev = schema.shopifyWidgetEvents;
  const inEventRange = and(
    eq(ev.storeId, storeId),
    gte(ev.createdAt, range.from),
    lt(ev.createdAt, range.to),
  );

  const [eventRow] = await db
    .select({
      addedToCart: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'add_to_cart')`,
      ),
      storeCap: int(sql`count(*) filter (where ${ev.type} = 'refused_store_cap')`),
      shopperCap: int(sql`count(*) filter (where ${ev.type} = 'refused_shopper_cap')`),
      emailGate: int(sql`count(*) filter (where ${ev.type} = 'refused_email_gate')`),
    })
    .from(ev)
    .where(inEventRange);

  const [emailRow] = await db
    .select({ n: int(sql`count(*)`) })
    .from(schema.shopifyShoppers)
    .where(
      and(
        eq(schema.shopifyShoppers.storeId, storeId),
        isNotNull(schema.shopifyShoppers.email),
        gte(schema.shopifyShoppers.emailCapturedAt, range.from),
        lt(schema.shopifyShoppers.emailCapturedAt, range.to),
      ),
    );

  const identified = identifiedRow.n;
  return {
    tryOns: jobRow.tryOns,
    uniqueShoppers: jobRow.uniqueShoppers,
    addedToCart: eventRow.addedToCart,
    addToCartRate: identified === 0 ? 0 : eventRow.addedToCart / identified,
    emailsCaptured: emailRow.n,
    turnedAway: {
      total: eventRow.storeCap + eventRow.shopperCap + eventRow.emailGate,
      storeCap: eventRow.storeCap,
      shopperCap: eventRow.shopperCap,
      emailGate: eventRow.emailGate,
    },
  };
}

/** YYYY-MM-DD strings between two instants, in the store's own calendar. */
function localDaySpan(range: AnalyticsRange): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: range.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const days: string[] = [];
  // Step in whole days from `from`; en-CA formats as YYYY-MM-DD natively.
  for (let t = range.from.getTime(); t < range.to.getTime(); t += 86_400_000) {
    const day = fmt.format(new Date(t));
    if (days[days.length - 1] !== day) days.push(day);
  }
  return days;
}

export async function analyticsDaily(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<{ day: string; tryOns: number }[]> {
  const rows = await db
    .select({
      day: sql<string>`to_char((${schema.jobs.createdAt} AT TIME ZONE ${range.timezone})::date, 'YYYY-MM-DD')`,
      tryOns: int(sql`count(*)`),
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        gte(schema.jobs.createdAt, range.from),
        lt(schema.jobs.createdAt, range.to),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // Zero-fill: a quiet day must render as an empty slot, not be skipped. A
  // skipped day compresses the x-axis and makes a gap look like a busy stretch.
  const counts = new Map(rows.map((r) => [r.day, r.tryOns]));
  return localDaySpan(range).map((day) => ({ day, tryOns: counts.get(day) ?? 0 }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-analytics`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/store-day.ts \
        apps/api/src/modules/shopify/analytics.ts \
        apps/api/test/shopify-analytics.test.ts
git commit -m "feat(shopify): analytics cards and store-local daily series"
```

---

## Task 5: Funnel and per-product aggregation

**Files:**
- Modify: `apps/api/src/modules/shopify/analytics.ts`
- Modify: `apps/api/test/shopify-analytics.test.ts`

**Interfaces:**
- Consumes: `AnalyticsRange`, `int` helper (Task 4).
- Produces:
  - `AnalyticsFunnel { buttonClick, upload, tryOn, resultView, addToCart, unattributed }`
  - `analyticsFunnel(db: DB, storeId: string, range: AnalyticsRange): Promise<AnalyticsFunnel>`
  - `AnalyticsProduct { shopifyProductId: number; title: string | null; tryOns: number; uniqueShoppers: number; addedToCart: number; addToCartRate: number }`
  - `analyticsProducts(db: DB, storeId: string, range: AnalyticsRange): Promise<AnalyticsProduct[]>`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shopify-analytics.test.ts`, and add
`analyticsFunnel, analyticsProducts` to the import from `analytics.js`:

```ts
describe('analyticsFunnel', () => {
  it('counts distinct shoppers per step, not raw events', async () => {
    const c = randomUUID();
    const s = await seedShopper(storeId, c);
    await seedJob(storeId, s, '2026-07-03T06:00:00Z');

    await seedEvent(storeId, 'button_click', c, '2026-07-03T05:00:00Z');
    await seedEvent(storeId, 'button_click', c, '2026-07-03T05:01:00Z');
    await seedEvent(storeId, 'button_click', c, '2026-07-03T05:02:00Z');
    await seedEvent(storeId, 'upload', c, '2026-07-03T05:03:00Z');
    await seedEvent(storeId, 'result_view', c, '2026-07-03T06:05:00Z');

    const funnel = await analyticsFunnel(app.db, storeId, range);

    // One enthusiastic shopper clicking three times is one shopper.
    expect(funnel.buttonClick).toBe(1);
    expect(funnel.upload).toBe(1);
    expect(funnel.resultView).toBe(1);
  });

  it('reports try-ons with no client_id as unattributed rather than dropping them', async () => {
    const funnel = await analyticsFunnel(app.db, storeId, range);
    // Seeded in the cards suite: one job with a null shopper.
    expect(funnel.unattributed).toBeGreaterThanOrEqual(1);
  });

  it('does not clamp a step to the one above it', async () => {
    // A shopper whose event calls were blocked still generated a real try-on,
    // so tryOn can legitimately exceed buttonClick. Clamping would hide that
    // the client-side steps are lossy.
    const c = randomUUID();
    const s = await seedShopper(storeId, c);
    await seedJob(storeId, s, '2026-07-07T06:00:00Z');

    const funnel = await analyticsFunnel(app.db, storeId, range);
    expect(funnel.tryOn).toBeGreaterThan(funnel.buttonClick);
  });
});

describe('analyticsProducts', () => {
  it('aggregates try-ons and add-to-carts per product', async () => {
    const c = randomUUID();
    const s = await seedShopper(storeId, c);
    await seedJob(storeId, s, '2026-07-02T08:00:00Z', 777);
    await seedJob(storeId, s, '2026-07-02T09:00:00Z', 777);
    await seedJob(storeId, s, '2026-07-02T10:00:00Z', 888);
    await seedEvent(storeId, 'add_to_cart', c, '2026-07-02T11:00:00Z', 777);

    await app.db.insert(schema.shopifyProductGarments).values({
      storeId,
      shopifyProductId: 777,
      shopifyVariantId: null,
      r2Key: 'x/777.jpg',
      title: 'Blue Shirt',
      status: 'active',
      enabled: true,
    });

    const products = await analyticsProducts(app.db, storeId, range);

    const p777 = products.find((p) => p.shopifyProductId === 777);
    expect(p777).toMatchObject({
      title: 'Blue Shirt',
      tryOns: 2,
      uniqueShoppers: 1,
      addedToCart: 1,
    });
    expect(p777?.addToCartRate).toBeCloseTo(1, 5);

    // A product with no garment row still appears — it just has no title.
    const p888 = products.find((p) => p.shopifyProductId === 888);
    expect(p888).toMatchObject({ title: null, tryOns: 1, addedToCart: 0 });
  });

  it('orders by try-ons descending', async () => {
    const products = await analyticsProducts(app.db, storeId, range);
    for (let i = 1; i < products.length; i++) {
      expect(products[i - 1].tryOns).toBeGreaterThanOrEqual(products[i].tryOns);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-analytics`
Expected: FAIL — `analyticsFunnel` and `analyticsProducts` are not exported.

- [ ] **Step 3: Implement the funnel**

Append to `apps/api/src/modules/shopify/analytics.ts`:

```ts
export interface AnalyticsFunnel {
  buttonClick: number;
  upload: number;
  tryOn: number;
  resultView: number;
  addToCart: number;
  /** Try-ons from widget builds that send no client_id — countable, not joinable. */
  unattributed: number;
}

export async function analyticsFunnel(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<AnalyticsFunnel> {
  const ev = schema.shopifyWidgetEvents;

  // Distinct shoppers per step, never raw event counts — one shopper clicking
  // five times is one shopper, and counting events would put later steps above
  // earlier ones for reasons that have nothing to do with drop-off.
  const [steps] = await db
    .select({
      buttonClick: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'button_click')`,
      ),
      upload: int(sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'upload')`),
      resultView: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'result_view')`,
      ),
      addToCart: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'add_to_cart')`,
      ),
    })
    .from(ev)
    .where(
      and(eq(ev.storeId, storeId), gte(ev.createdAt, range.from), lt(ev.createdAt, range.to)),
    );

  const inJobRange = and(
    eq(schema.jobs.shopifyStoreId, storeId),
    gte(schema.jobs.createdAt, range.from),
    lt(schema.jobs.createdAt, range.to),
  );

  const [tryOnRow] = await db
    .select({ n: int(sql`count(distinct ${schema.shopifyShoppers.clientId})`) })
    .from(schema.jobs)
    .innerJoin(
      schema.shopifyShoppers,
      eq(schema.jobs.shopifyShopperId, schema.shopifyShoppers.id),
    )
    .where(inJobRange);

  const [unattributedRow] = await db
    .select({ n: int(sql`count(*)`) })
    .from(schema.jobs)
    .where(and(inJobRange, sql`${schema.jobs.shopifyShopperId} is null`));

  // Returned exactly as measured. The caller must NOT clamp these to be
  // monotonic: a shopper running an ad blocker that eats the event endpoint
  // still generates a real try-on, and hiding that would hide that the
  // client-side steps under-report.
  return {
    buttonClick: steps.buttonClick,
    upload: steps.upload,
    tryOn: tryOnRow.n,
    resultView: steps.resultView,
    addToCart: steps.addToCart,
    unattributed: unattributedRow.n,
  };
}
```

- [ ] **Step 4: Implement per-product aggregation**

Append to the same file:

```ts
export interface AnalyticsProduct {
  shopifyProductId: number;
  title: string | null;
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  addToCartRate: number;
}

export async function analyticsProducts(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<AnalyticsProduct[]> {
  // No expression index on the JSONB is needed: `jobs` is filtered first by
  // (shopify_store_id, created_at), then job_inputs is reached by its own
  // primary key, so the params extraction only ever runs on the narrowed set.
  const productId = sql<number>`(${schema.jobInputs.params}->>'shopifyProductId')::bigint`;

  const jobRows = await db
    .select({
      productId,
      tryOns: int(sql`count(*)`),
      uniqueShoppers: int(sql`count(distinct ${schema.jobs.shopifyShopperId})`),
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        gte(schema.jobs.createdAt, range.from),
        lt(schema.jobs.createdAt, range.to),
        sql`${schema.jobInputs.params}->>'shopifyProductId' is not null`,
      ),
    )
    .groupBy(sql`1`);

  const ev = schema.shopifyWidgetEvents;
  const cartRows = await db
    .select({
      productId: ev.shopifyProductId,
      addedToCart: int(sql`count(distinct ${ev.clientId})`),
    })
    .from(ev)
    .where(
      and(
        eq(ev.storeId, storeId),
        eq(ev.type, 'add_to_cart'),
        gte(ev.createdAt, range.from),
        lt(ev.createdAt, range.to),
        isNotNull(ev.shopifyProductId),
      ),
    )
    .groupBy(ev.shopifyProductId);

  const titleRows = await db
    .select({
      productId: schema.shopifyProductGarments.shopifyProductId,
      title: schema.shopifyProductGarments.title,
    })
    .from(schema.shopifyProductGarments)
    .where(eq(schema.shopifyProductGarments.storeId, storeId));

  const carts = new Map(cartRows.map((r) => [Number(r.productId), r.addedToCart]));
  const titles = new Map(titleRows.map((r) => [Number(r.productId), r.title]));

  return jobRows
    .map((r) => {
      const id = Number(r.productId);
      const addedToCart = carts.get(id) ?? 0;
      return {
        shopifyProductId: id,
        title: titles.get(id) ?? null,
        tryOns: r.tryOns,
        uniqueShoppers: r.uniqueShoppers,
        addedToCart,
        addToCartRate: r.uniqueShoppers === 0 ? 0 : addedToCart / r.uniqueShoppers,
      };
    })
    .sort((a, b) => b.tryOns - a.tryOns);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-analytics`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/analytics.ts apps/api/test/shopify-analytics.test.ts
git commit -m "feat(shopify): analytics funnel and per-product aggregation"
```

---

## Task 6: Analytics endpoint

**Files:**
- Modify: `packages/types/src/widget.ts` (append)
- Create: `apps/api/src/modules/shopify/analytics.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `apps/api/test/shopify-analytics.test.ts`

**Interfaces:**
- Consumes: `analyticsCards`, `analyticsDaily`, `analyticsFunnel`, `analyticsProducts`, `AnalyticsRange` (Tasks 4-5); `localDayStart` (Task 4).
- Produces:
  - `ShopifyAnalyticsQuery` from `@tryme/types`
  - `shopifyAnalyticsRoutes(app: FastifyInstance)`
  - `GET /v1/shopify/analytics?from=&to=` → `{ range, cards, daily, funnel, products }`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/shopify-analytics.test.ts`. It needs a session token —
add these imports and the token setup, matching `apps/api/test/shopify-me.test.ts`:

```ts
import { signSessionToken } from './helpers/shopify-session.js';
```

In `beforeAll`, pass `SHOPIFY_API_SECRET: 'test-secret'` and
`SHOPIFY_API_KEY: 'test-key'` to `buildTestApp`, and after creating the store:

```ts
  token = signSessionToken('an.myshopify.com', 'test-secret', 'test-key');
```

with `let token: string;` declared alongside the other module-level lets. Then:

```ts
describe('GET /v1/shopify/analytics', () => {
  function get(qs: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/shopify/analytics?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('returns every section for a valid range', async () => {
    const res = await get('from=2026-07-01&to=2026-07-07');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.range.timezone).toBe(TZ);
    expect(body.cards.tryOns).toBeGreaterThan(0);
    expect(body.daily).toHaveLength(7);
    expect(body.funnel).toHaveProperty('unattributed');
    expect(Array.isArray(body.products)).toBe(true);
  });

  it('includes the last day of the range', async () => {
    // `to` is inclusive to the merchant; the resolved instant is exclusive.
    const res = await get('from=2026-07-07&to=2026-07-07');
    expect(res.json().daily).toEqual([{ day: '2026-07-07', tryOns: expect.any(Number) }]);
  });

  it('rejects a reversed range', async () => {
    const res = await get('from=2026-07-08&to=2026-07-01');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a range longer than 400 days', async () => {
    // Beyond the events retention horizon the window is partly swept, which
    // would read as a traffic collapse rather than as missing data.
    const res = await get('from=2024-01-01&to=2026-07-07');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed date', async () => {
    const res = await get('from=July&to=2026-07-07');
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-analytics`
Expected: FAIL — the analytics requests 404.

- [ ] **Step 3: Add the query schema**

Append to `packages/types/src/widget.ts`:

```ts
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `from` and `to` are bare calendar dates naming days in the STORE's timezone,
 * both inclusive from the merchant's point of view. The server resolves them to
 * instants; see localDayStart.
 */
export const ShopifyAnalyticsQuery = z
  .object({
    from: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD'),
    to: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD'),
  })
  .refine((q) => q.to >= q.from, { message: 'to must not be before from' })
  .refine(
    (q) => {
      // Compared as UTC purely to bound the span — a few hours of timezone
      // skew cannot matter against a 400-day ceiling.
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      return days <= 400;
    },
    { message: 'range must not exceed 400 days' },
  );
export type ShopifyAnalyticsQuery = z.infer<typeof ShopifyAnalyticsQuery>;
```

- [ ] **Step 4: Implement the route**

Create `apps/api/src/modules/shopify/analytics.routes.ts`:

```ts
import type { schema as dbSchema } from '@tryme/db';
import { ShopifyAnalyticsQuery } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import {
  type AnalyticsRange,
  analyticsCards,
  analyticsDaily,
  analyticsFunnel,
  analyticsProducts,
} from './analytics.js';
import { localDayStart } from './store-day.js';

const DAY_MS = 86_400_000;

export async function shopifyAnalyticsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/shopify/analytics',
    {
      preValidation: app.requireShopifySession,
      schema: { querystring: ShopifyAnalyticsQuery },
    },
    async (req) => {
      const store = req.shopifyStore as typeof dbSchema.shopifyStores.$inferSelect;
      const { from, to } = req.query as ShopifyAnalyticsQuery;

      // `to` is inclusive to the merchant — "1st to 7th" must contain the 7th.
      // Internally every query is half-open, so resolve it to the start of the
      // following local day rather than to the 7th's own midnight.
      const toStart = localDayStart(store.ianaTimezone, to);
      const range: AnalyticsRange = {
        from: localDayStart(store.ianaTimezone, from),
        to: new Date(toStart.getTime() + DAY_MS),
        timezone: store.ianaTimezone ?? 'UTC',
      };

      const [cards, daily, funnel, products] = await Promise.all([
        analyticsCards(app.db, store.id, range),
        analyticsDaily(app.db, store.id, range),
        analyticsFunnel(app.db, store.id, range),
        analyticsProducts(app.db, store.id, range),
      ]);

      return { range: { from, to, timezone: range.timezone }, cards, daily, funnel, products };
    },
  );
}
```

**Note on the `to` boundary:** adding a fixed 24 hours is correct here because
`localDayStart` resolves the *following* calendar date independently in the
zone-aware helper only when given that date. If a DST transition falls on `to`,
the added day can land an hour early or late. That is acceptable — it shifts at
most one hour of activity at the very edge of a range — and avoiding it entirely
would mean date arithmetic in the store's calendar, which `store-day.ts` does not
expose. Record this in the code comment; do not silently ignore it.

- [ ] **Step 5: Register the route**

In `apps/api/src/modules/shopify/routes.ts`:

```ts
import { shopifyAnalyticsRoutes } from './analytics.routes.js';
```

and register it after `shopifyEventsRoutes`:

```ts
  await app.register(shopifyAnalyticsRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-analytics`
Expected: PASS, 15 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/shopify/analytics.routes.ts \
        apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-analytics.test.ts
git commit -m "feat(shopify): analytics endpoint with store-local date ranges"
```

---

## Task 7: Events retention pass

**Files:**
- Modify: `apps/dispatcher/src/shopify/retention.ts`
- Test: `apps/dispatcher/test/integration/shopify-events-retention.test.ts` (create)

**Interfaces:**
- Consumes: `schema.shopifyWidgetEvents` (Task 1); the existing `runShopifyRetention(db, storage, log)`.
- Produces: no new export — `runShopifyRetention` gains a fourth pass.

- [ ] **Step 1: Write the failing test**

Create `apps/dispatcher/test/integration/shopify-events-retention.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runShopifyRetention } from '../../src/shopify/retention.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const DAY = 86_400_000;
const log = createLogger('test');

describe('shopify retention — widget events', () => {
  let env: TestEnv;
  let storeId: string;

  beforeAll(async () => {
    env = await setupTestEnv();
    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `ret-${randomUUID()}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1e9),
        accessToken: 'x',
        scope: 'read_products',
        settings: {},
      })
      .returning();
    storeId = store.id;
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  it('deletes events past 400 days and keeps everything newer', async () => {
    await env.db.insert(schema.shopifyWidgetEvents).values([
      { storeId, type: 'button_click', createdAt: new Date(Date.now() - 401 * DAY) },
      { storeId, type: 'button_click', createdAt: new Date(Date.now() - 399 * DAY) },
      { storeId, type: 'add_to_cart', createdAt: new Date() },
    ]);

    await runShopifyRetention(env.db, env.storage, log);

    const rows = await env.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(eq(schema.shopifyWidgetEvents.storeId, storeId));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Date.now() - r.createdAt.getTime() < 400 * DAY)).toBe(true);
  });

  it('sweeps events even for a store with no retention settings configured', async () => {
    // The 400-day events horizon is fixed, not merchant-configurable — the
    // other three passes bail on `if (!retention) continue`, and this pass must
    // not be trapped behind that guard.
    const rows = await env.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(eq(schema.shopifyWidgetEvents.storeId, storeId));
    expect(rows).toHaveLength(2);
  });
});
```

If `TestEnv` does not expose `storage`, read
`apps/dispatcher/test/helpers/containers.ts` and use whatever it does provide;
this pass never touches storage, so any valid `StorageProvider` will do.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/dispatcher test -- shopify-events-retention`
Expected: FAIL — all three seeded rows survive.

- [ ] **Step 3: Implement the pass**

In `apps/dispatcher/src/shopify/retention.ts`, add `shopifyWidgetEvents` usage
and place this pass **outside** the `for (const store of stores)` loop, at the
end of `runShopifyRetention`:

```ts
  // Fixed 400-day horizon, deliberately not merchant-configurable and
  // deliberately not inside the per-store loop above: that loop bails early on
  // `if (!retention) continue`, and this sweep must run for every store. 400
  // days covers an "all time" analytics range plus year-over-year comparison,
  // and it is the same ceiling the analytics endpoint enforces on a requested
  // range — a merchant who could shorten it would silently destroy their own
  // history and see it as a traffic collapse.
  const eventCutoff = daysAgo(400);
  const stale = await db
    .select({ id: schema.shopifyWidgetEvents.id })
    .from(schema.shopifyWidgetEvents)
    .where(lt(schema.shopifyWidgetEvents.createdAt, eventCutoff))
    .limit(BATCH);

  if (stale.length > 0) {
    await db.delete(schema.shopifyWidgetEvents).where(
      inArray(
        schema.shopifyWidgetEvents.id,
        stale.map((r) => r.id),
      ),
    );
    log.info({ deleted: stale.length }, 'shopify retention: swept widget events');
  }
```

Add `inArray` to the `drizzle-orm` import at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tryme/dispatcher test -- shopify-events-retention`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/shopify/retention.ts \
        apps/dispatcher/test/integration/shopify-events-retention.test.ts
git commit -m "feat(shopify): sweep widget events past the 400-day horizon"
```

---

## Task 8: Widget instrumentation

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`

**Interfaces:**
- Consumes: `POST /v1/shopify/customer/event` (Task 2); `clientId` and `apiBase`, already in scope inside `initWidget` after the shopper-limits and Widget Design work.
- Produces: no exports — this file is an IIFE.

**Verification is manual** (dev store). The theme extension has no test runner,
and introducing one for a browser IIFE is out of scope. Do **not** invent
automated tests to fill the gap; if you cannot run the dev-store checks, say so
and mark Step 4 unverified rather than done.

- [ ] **Step 1: Add the helper**

Inside `initWidget`, near the other module-scoped helpers, add:

```js
    // Coarse and honest: a width test, not device detection. Labeled as an
    // estimate in the merchant UI rather than presented as fact.
    const device = window.innerWidth < 768 ? 'mobile' : 'desktop';

    // Fire-and-forget. Analytics must never break a try-on, so every failure
    // path here is silent: a rejected promise, a thrown TypeError from a
    // missing API, an ad blocker eating the request — all identical to success
    // from the shopper's point of view.
    //
    // keepalive matters for add_to_cart specifically: the shopper may navigate
    // to /cart before the request settles, and without it the browser cancels
    // the very event that measures conversion.
    function trackEvent(type) {
      try {
        fetch(`${apiBase}/v1/shopify/customer/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Widget-Key': widgetKey },
          body: JSON.stringify({
            type,
            clientId: clientId || undefined,
            shopifyProductId: productId || undefined,
            device,
          }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* analytics must never break a try-on */
      }
    }
```

`widgetKey`, `apiBase` and `productId` are already read from `root.dataset` at
the top of `initWidget`. `clientId` is minted and persisted by the shopper-limits
work — confirm the variable name with
`grep -n "clientId" apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`
before writing this, and use whatever that file actually calls it.

- [ ] **Step 2: Add the five fire points**

| Where | Call |
|---|---|
| The click handler that unhides `.tryme-tryon__modal` | `trackEvent('button_click');` |
| In the file-input change handler, after the file passes the `MAX_PHOTO_BYTES` check | `trackEvent('upload');` |
| Inside `showStep`, in the branch that reveals the result step — or immediately after each `showStep('result')` call site | `trackEvent('result_view');` |
| In `addCurrentVariantToCart`, immediately after the success branch sets `Added ✓` | `trackEvent('add_to_cart');` |
| In the result-step share handler, at the top of `shareResult` | `trackEvent('share');` |

Put `trackEvent('result_view')` at the `showStep('result')` **call sites**, not
inside `showStep` itself — `showStep` is also used to restore the result view
when a shopper navigates back from history, and counting that as a fresh result
view would inflate the funnel step above the try-ons that produced it.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 4: Verify on a dev store**

With the extension deployed and the browser network tab open:

1. Open a product page and click the try-on button → one `POST /customer/event`
   with `type: "button_click"`, answering **204**.
2. Choose a photo → one `upload` event.
3. Let the generation finish → one `result_view` event.
4. Click Add to Cart → one `add_to_cart` event carrying the right
   `shopifyProductId`.
5. Click Share → one `share` event.
6. Open history and re-view a past result → **no** additional `result_view`.
7. Block the endpoint in devtools (right-click the request → Block request URL)
   and run a full try-on → the try-on still completes normally with no visible
   error.
8. Confirm rows landed:
   ```bash
   psql "$DATABASE_URL" -c "select type, count(*) from shopify_widget_events group by 1;"
   ```

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js
git commit -m "feat(shopify): instrument widget funnel events"
```

---

## Task 9: Analytics page — range control, KPI tiles, product table

**Files:**
- Create: `apps/shopify/src/lib/analyticsRange.ts`
- Create: `apps/shopify/src/lib/analyticsRange.test.ts`
- Create: `apps/shopify/src/pages/AnalyticsPage.tsx`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppNavMenu.tsx`

**Interfaces:**
- Consumes: `GET /v1/shopify/analytics` (Task 6); `apiFetch<T>(path, init?)` from `./lib/api`.
- Produces:
  - `ANALYTICS_PRESETS`, `resolvePreset(preset: AnalyticsPreset, installedAt: Date, today: Date): { from: string; to: string }` from `./lib/analyticsRange`
  - `ShopifyAnalytics` response type in `apps/shopify/src/types.ts`

This task assumes Vitest exists in `apps/shopify`, added by the Widget Design
plan's Task 7. If `grep -n '"test"' apps/shopify/package.json` finds nothing, add
it exactly as that plan specifies — `vitest` at `^2.1.3`, a `vitest.config.ts`
with `environment: 'node'` and `include: ['src/**/*.test.ts']`, and a
`"test": "vitest run"` script — before continuing.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify/src/lib/analyticsRange.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolvePreset } from './analyticsRange';

const today = new Date('2026-07-31T00:00:00Z');
const installedAt = new Date('2026-06-15T00:00:00Z');

describe('resolvePreset', () => {
  it('7d covers today and the six days before it', () => {
    // Inclusive of both ends — seven days total, not eight.
    expect(resolvePreset('7d', installedAt, today)).toEqual({
      from: '2026-07-25',
      to: '2026-07-31',
    });
  });

  it('30d covers today and the twenty-nine days before it', () => {
    expect(resolvePreset('30d', installedAt, today)).toEqual({
      from: '2026-07-02',
      to: '2026-07-31',
    });
  });

  it('90d covers today and the eighty-nine days before it', () => {
    expect(resolvePreset('90d', installedAt, today)).toEqual({
      from: '2026-05-03',
      to: '2026-07-31',
    });
  });

  it('all starts at the install date', () => {
    expect(resolvePreset('all', installedAt, today)).toEqual({
      from: '2026-06-15',
      to: '2026-07-31',
    });
  });

  it('clamps all-time to 400 days so the API never rejects it', () => {
    // The events retention horizon is 400 days and the endpoint enforces it.
    // A store installed five years ago must still get a working "All time".
    const ancient = new Date('2021-01-01T00:00:00Z');
    const { from, to } = resolvePreset('all', ancient, today);
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/shopify-admin test`
Expected: FAIL — `./analyticsRange` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `apps/shopify/src/lib/analyticsRange.ts`:

```ts
export const ANALYTICS_PRESETS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'all', label: 'All time' },
] as const;

export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number]['id'];

const DAY_MS = 86_400_000;
/** Matches the events retention horizon and the API's own range ceiling. */
const MAX_RANGE_DAYS = 400;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Turn a preset into the inclusive `from`/`to` calendar dates the API takes.
 *
 * Resolved client-side on purpose: the server then has exactly one code path
 * for both presets and the custom picker, rather than a second preset vocabulary
 * to keep in sync.
 */
export function resolvePreset(
  preset: AnalyticsPreset,
  installedAt: Date,
  today: Date = new Date(),
): { from: string; to: string } {
  const spanDays: Record<Exclude<AnalyticsPreset, 'all'>, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
  };

  const start =
    preset === 'all'
      ? installedAt
      : new Date(today.getTime() - (spanDays[preset] - 1) * DAY_MS);

  // Both ends inclusive, so "last 7 days" spans today plus the six before it.
  const earliest = new Date(today.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS);
  const clamped = start < earliest ? earliest : start;

  return { from: iso(clamped), to: iso(today) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tryme/shopify-admin test`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the response types**

Append to `apps/shopify/src/types.ts`:

```ts
export interface ShopifyAnalyticsCards {
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  addToCartRate: number;
  emailsCaptured: number;
  turnedAway: { total: number; storeCap: number; shopperCap: number; emailGate: number };
}

export interface ShopifyAnalyticsFunnel {
  buttonClick: number;
  upload: number;
  tryOn: number;
  resultView: number;
  addToCart: number;
  unattributed: number;
}

export interface ShopifyAnalyticsProduct {
  shopifyProductId: number;
  title: string | null;
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  addToCartRate: number;
}

export interface ShopifyAnalytics {
  range: { from: string; to: string; timezone: string };
  cards: ShopifyAnalyticsCards;
  daily: { day: string; tryOns: number }[];
  funnel: ShopifyAnalyticsFunnel;
  products: ShopifyAnalyticsProduct[];
}
```

- [ ] **Step 6: Build the page**

Create `apps/shopify/src/pages/AnalyticsPage.tsx`. Charts arrive in Task 10;
this ships the range control, KPI tiles and product table.

```tsx
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DatePicker,
  IndexTable,
  InlineGrid,
  InlineStack,
  OptionList,
  Page,
  Popover,
  Spinner,
  Text,
} from '@shopify/polaris';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import {
  ANALYTICS_PRESETS,
  type AnalyticsPreset,
  resolvePreset,
} from '../lib/analyticsRange';
import type { ShopifyAnalytics, ShopifyMe } from '../types';

// A headline number and its label. Deliberately no sparkline and no decoration
// — per the dataviz skill these are stat tiles, not charts.
function StatTile({ label, value, action }: { label: string; value: string; action?: ReactNode }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="p" variant="heading2xl">
          {value}
        </Text>
        {action}
      </BlockStack>
    </Card>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [installedAt, setInstalledAt] = useState<Date | null>(null);
  const [preset, setPreset] = useState<AnalyticsPreset>('30d');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<ShopifyAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [month, setMonth] = useState({ month: new Date().getMonth(), year: new Date().getFullYear() });

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((me) => {
        const installed = new Date(me.store.connectedSince);
        setInstalledAt(installed);
        setRange(resolvePreset('30d', installed));
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!range) return;
    setLoading(true);
    apiFetch<ShopifyAnalytics>(`/v1/shopify/analytics?from=${range.from}&to=${range.to}`)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [range]);

  const choosePreset = useCallback(
    (selected: string[]) => {
      const next = selected[0] as AnalyticsPreset;
      setPreset(next);
      if (installedAt) setRange(resolvePreset(next, installedAt));
      setPickerOpen(false);
    },
    [installedAt],
  );

  const label =
    ANALYTICS_PRESETS.find((p) => p.id === preset)?.label ??
    (range ? `${range.from} – ${range.to}` : 'Select dates');

  return (
    <Page title="Analytics">
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <InlineStack align="start">
          <Popover
            active={pickerOpen}
            activator={<Button onClick={() => setPickerOpen((o) => !o)}>{label}</Button>}
            onClose={() => setPickerOpen(false)}
          >
            <Box padding="200">
              <InlineStack gap="400" align="start" blockAlign="start">
                <OptionList
                  options={ANALYTICS_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  selected={[preset]}
                  onChange={choosePreset}
                />
                <DatePicker
                  month={month.month}
                  year={month.year}
                  onMonthChange={(m, y) => setMonth({ month: m, year: y })}
                  allowRange
                  selected={
                    range
                      ? { start: new Date(range.from), end: new Date(range.to) }
                      : undefined
                  }
                  onChange={({ start, end }) => {
                    setRange({
                      from: start.toISOString().slice(0, 10),
                      to: end.toISOString().slice(0, 10),
                    });
                    setPickerOpen(false);
                  }}
                />
              </InlineStack>
            </Box>
          </Popover>
        </InlineStack>

        {loading && !data ? (
          <Spinner accessibilityLabel="Loading analytics" />
        ) : data ? (
          <>
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 3 }} gap="400">
              <StatTile label="Try-ons" value={String(data.cards.tryOns)} />
              <StatTile label="Unique shoppers" value={String(data.cards.uniqueShoppers)} />
              <StatTile label="Added to cart" value={String(data.cards.addedToCart)} />
              {/* Never "Conversion rate" — a merchant reads that as purchased. */}
              <StatTile label="Add-to-cart rate" value={pct(data.cards.addToCartRate)} />
              {/* The list itself lives on Settings -> Data, where the GDPR
                  delete controls are. Duplicating it here would mean two places
                  to erase a shopper from, so this links across instead. */}
              <StatTile
                label="Emails captured"
                value={String(data.cards.emailsCaptured)}
                action={
                  <Button variant="plain" onClick={() => navigate('/settings')}>
                    View list
                  </Button>
                }
              />
              <StatTile label="Turned away" value={String(data.cards.turnedAway.total)} />
            </InlineGrid>

            {data.cards.turnedAway.total > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Shoppers you turned away
                  </Text>
                  <InlineStack gap="200">
                    <Badge>{`Store daily cap: ${data.cards.turnedAway.storeCap}`}</Badge>
                    <Badge>{`Per-shopper cap: ${data.cards.turnedAway.shopperCap}`}</Badge>
                    <Badge>{`Email required: ${data.cards.turnedAway.emailGate}`}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    These shoppers wanted a try-on and did not get one. Adjust your limits in
                    Settings.
                  </Text>
                </BlockStack>
              </Card>
            )}

            <Card padding="0">
              <Box padding="400">
                <Text as="h2" variant="headingMd">
                  Products
                </Text>
              </Box>
              <IndexTable
                resourceName={{ singular: 'product', plural: 'products' }}
                itemCount={data.products.length}
                selectable={false}
                headings={[
                  { title: 'Product' },
                  { title: 'Try-ons' },
                  { title: 'Shoppers' },
                  { title: 'Added to cart' },
                  { title: 'Add-to-cart rate' },
                ]}
              >
                {data.products.map((p, i) => (
                  <IndexTable.Row
                    id={String(p.shopifyProductId)}
                    key={p.shopifyProductId}
                    position={i}
                  >
                    <IndexTable.Cell>{p.title ?? `#${p.shopifyProductId}`}</IndexTable.Cell>
                    <IndexTable.Cell>{p.tryOns}</IndexTable.Cell>
                    <IndexTable.Cell>{p.uniqueShoppers}</IndexTable.Cell>
                    <IndexTable.Cell>{p.addedToCart}</IndexTable.Cell>
                    <IndexTable.Cell>{pct(p.addToCartRate)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </>
        ) : null}
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 7: Register the route and nav entry**

In `apps/shopify/src/App.tsx`, add the import and the route after `/manage`:

```tsx
import AnalyticsPage from './pages/AnalyticsPage';
```

```tsx
          <Route path="/analytics" element={<AnalyticsPage />} />
```

In `apps/shopify/src/components/AppNavMenu.tsx`, add `ChartVerticalIcon` to the
`@shopify/polaris-icons` import and insert the entry after Manage:

```tsx
  { path: '/analytics', label: 'Analytics', icon: ChartVerticalIcon },
```

If the Widget Design plan has already added its own entry, the final order is
Dashboard → Manage → Analytics → Widget Design → Settings → Support.

- [ ] **Step 8: Verify by hand**

Run: `pnpm --filter @tryme/shopify-admin dev`, open `/analytics`.

1. The page loads with Last 30 days selected.
2. Switching to Last 7 days refetches and the numbers change.
3. Picking a custom range in the calendar refetches.
4. The product table lists products, most-tried-on first.
5. With no data, tiles read 0 and the table is empty rather than erroring.

- [ ] **Step 9: Typecheck and lint**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify): analytics page with date range and product table"
```

---

## Task 10: Daily and funnel charts

**Files:**
- Create: `apps/shopify/src/components/BarChart.tsx`
- Create: `apps/shopify/src/components/ChartTable.tsx`
- Modify: `apps/shopify/src/pages/AnalyticsPage.tsx`

**Interfaces:**
- Consumes: `data.daily` and `data.funnel` from Task 9's fetch.
- Produces:
  - `BarChart({ data, orientation, formatValue }: { data: { label: string; value: number }[]; orientation: 'vertical' | 'horizontal'; formatValue?: (n: number) => string })`
  - `ChartTable({ columns, rows }: { columns: [string, string]; rows: { label: string; value: string }[] })`

- [ ] **Step 1: Build the bar primitive**

Create `apps/shopify/src/components/BarChart.tsx`:

```tsx
import { useState } from 'react';

export interface Bar {
  label: string;
  value: number;
}

/**
 * One SVG bar primitive in two orientations — vertical for the daily series,
 * horizontal for the funnel. Hand-rolled rather than pulling a charting
 * dependency: both charts here are single-series magnitude, and a library would
 * add a large tree and its own provider for ~60 lines of geometry.
 *
 * Colors are Polaris tokens, not hard-coded hex, so the chart follows the
 * admin's light/dark theme instead of needing a second hand-picked palette.
 * Single series means no legend — the surrounding heading names it.
 */
export function BarChart({
  data,
  orientation,
  formatValue = (n) => String(n),
}: {
  data: Bar[];
  orientation: 'vertical' | 'horizontal';
  formatValue?: (n: number) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));

  if (orientation === 'horizontal') {
    const ROW = 34;
    return (
      <div style={{ position: 'relative' }}>
        <svg
          width="100%"
          height={data.length * ROW}
          role="img"
          aria-label="Funnel by step"
          style={{ overflow: 'visible' }}
        >
          {data.map((d, i) => (
            <g
              key={d.label}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Full-width hit target: the bar itself can be 1px wide at zero. */}
              <rect x="0" y={i * ROW} width="100%" height={ROW} fill="transparent" />
              <rect
                x="0"
                y={i * ROW + 6}
                width={`${(d.value / max) * 70}%`}
                height={ROW - 14}
                rx="4"
                fill="var(--p-color-bg-fill-brand)"
                opacity={hovered === null || hovered === i ? 1 : 0.5}
              />
              <text
                x="72%"
                y={i * ROW + ROW / 2 + 4}
                fontSize="12"
                fill="var(--p-color-text)"
              >
                {formatValue(d.value)} · {d.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    );
  }

  const COL = 100 / Math.max(1, data.length);
  return (
    <svg width="100%" height="180" role="img" aria-label="Try-ons per day">
      {data.map((d, i) => {
        const h = (d.value / max) * 150;
        return (
          <g
            key={d.label}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <rect x={`${i * COL}%`} y="0" width={`${COL}%`} height="180" fill="transparent" />
            <rect
              x={`${i * COL + COL * 0.15}%`}
              y={160 - h}
              width={`${COL * 0.7}%`}
              height={Math.max(h, d.value > 0 ? 2 : 0)}
              rx="4"
              fill="var(--p-color-bg-fill-brand)"
              opacity={hovered === null || hovered === i ? 1 : 0.5}
            />
            {hovered === i && (
              <text
                x={`${i * COL + COL / 2}%`}
                y={Math.max(12, 152 - h)}
                fontSize="12"
                textAnchor="middle"
                fill="var(--p-color-text)"
              >
                {formatValue(d.value)}
              </text>
            )}
          </g>
        );
      })}
      {/* Selective labels only — first and last. A number on every bar is noise. */}
      <text x="0" y="176" fontSize="11" fill="var(--p-color-text-secondary)">
        {data[0]?.label}
      </text>
      <text x="100%" y="176" fontSize="11" textAnchor="end" fill="var(--p-color-text-secondary)">
        {data[data.length - 1]?.label}
      </text>
    </svg>
  );
}
```

- [ ] **Step 2: Build the table view**

Create `apps/shopify/src/components/ChartTable.tsx`:

```tsx
import { Collapsible, Button, DataTable } from '@shopify/polaris';
import { useState } from 'react';

/**
 * The non-graphical equivalent of a chart. Required rather than optional: a
 * chart that can only be read by looking at it is unreadable to anyone using a
 * screen reader.
 */
export function ChartTable({
  id,
  columns,
  rows,
}: {
  /** Distinct per instance — two of these render on the Analytics page, and a
   *  shared id would point both disclosure buttons at the same region. */
  id: string;
  columns: [string, string];
  rows: { label: string; value: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="plain" onClick={() => setOpen((o) => !o)} ariaExpanded={open} ariaControls={id}>
        {open ? 'Hide data table' : 'View as table'}
      </Button>
      <Collapsible open={open} id={id}>
        <DataTable
          columnContentTypes={['text', 'numeric']}
          headings={columns}
          rows={rows.map((r) => [r.label, r.value])}
        />
      </Collapsible>
    </>
  );
}
```

- [ ] **Step 3: Render both charts on the page**

In `AnalyticsPage.tsx`, add the imports and insert these two cards between the
turned-away card and the products table:

```tsx
import { BarChart } from '../components/BarChart';
import { ChartTable } from '../components/ChartTable';
```

```tsx
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Try-ons per day
                </Text>
                <BarChart
                  orientation="vertical"
                  data={data.daily.map((d) => ({ label: d.day, value: d.tryOns }))}
                />
                <ChartTable
                  id="daily-table"
                  columns={['Day', 'Try-ons']}
                  rows={data.daily.map((d) => ({ label: d.day, value: String(d.tryOns) }))}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Shopper journey
                </Text>
                <BarChart
                  orientation="horizontal"
                  data={[
                    { label: 'Clicked try-on', value: data.funnel.buttonClick },
                    { label: 'Uploaded a photo', value: data.funnel.upload },
                    { label: 'Generated a try-on', value: data.funnel.tryOn },
                    { label: 'Viewed the result', value: data.funnel.resultView },
                    { label: 'Added to cart', value: data.funnel.addToCart },
                  ]}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  Steps 1, 2, 4 and 5 are measured in the shopper&apos;s browser and can be
                  blocked. Try-ons are measured on our servers and are exact — so a later step
                  can show more shoppers than an earlier one.
                </Text>
                {data.funnel.unattributed > 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {`${data.funnel.unattributed} try-ons came from an older widget version and could not be matched to a shopper, so they are not in this chart.`}
                  </Text>
                )}
                <ChartTable
                  id="funnel-table"
                  columns={['Step', 'Shoppers']}
                  rows={[
                    { label: 'Clicked try-on', value: String(data.funnel.buttonClick) },
                    { label: 'Uploaded a photo', value: String(data.funnel.upload) },
                    { label: 'Generated a try-on', value: String(data.funnel.tryOn) },
                    { label: 'Viewed the result', value: String(data.funnel.resultView) },
                    { label: 'Added to cart', value: String(data.funnel.addToCart) },
                  ]}
                />
              </BlockStack>
            </Card>
```

**Do not clamp the funnel values.** Rendering them as measured is the point —
see the note the page itself displays.

- [ ] **Step 4: Verify contrast in both themes**

The dataviz skill requires the bar fill be checked against the chart surface in
light and dark, not assumed. With the page open, toggle the Shopify admin's
theme (or force it with `prefers-color-scheme` in devtools) and confirm the bars
remain clearly visible against the card background in both. If
`--p-color-bg-fill-brand` washes out in either mode, switch to
`--p-color-bg-fill-emphasis` and re-check.

- [ ] **Step 5: Verify by hand**

1. The daily chart shows one bar per day in the range, with zero-days rendering
   as an empty slot rather than being skipped.
2. Hovering a bar shows its value.
3. The funnel shows five bars.
4. "View as table" expands under each chart independently.
5. With a store whose events are blocked, the try-on step legitimately exceeds
   the click step and the page does not hide it.

- [ ] **Step 6: Typecheck, lint, test**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm lint && pnpm --filter @tryme/shopify-admin test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify): daily and funnel charts on analytics page"
```

---

## Task 11: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/progress.md`

- [ ] **Step 1: Document the events table**

In `CLAUDE.md`, add `shopify_widget_events` to the Widget / Merchant table in the
Database Schema section:

```markdown
| `shopify_widget_events` | Append-only storefront interaction log (clicks, uploads, result views, add-to-carts, shares, and server-written refusals). Advisory only — never read by a credit, limit, or authorization decision. Swept at a fixed 400 days |
```

And add a row to the API Route Modules table:

```markdown
| `shopify/` | …existing…; `POST /v1/shopify/customer/event` (public ingest), `GET /v1/shopify/analytics` |
```

- [ ] **Step 2: Add a progress entry**

Add a new dated entry at the **top** of `docs/progress.md`:

```markdown
## 2026-07-31 — Shopify Analytics

**Done**
- `shopify_widget_events` (migration 0135) plus the missing
  `jobs (shopify_store_id, created_at)` index. `bigserial` PK, deliberately not
  uuid — highest-write-rate table in the system, and random uuids fragment the
  index.
- `POST /v1/shopify/customer/event`, public and store-key authed, 600/min per
  store. Over-budget events are dropped with a 204, never a 429 — analytics must
  not break a shopper's try-on.
- Refusal events written at the three 202 sites in `customer.routes.ts`. NOT in
  `limits.ts` as the design doc said: `checkShopperLimits` runs twice per
  request and the transactional call rolls back on refusal.
- `analytics.ts` — cards, store-local daily series with zero-fill, funnel by
  distinct shopper, per-product aggregation. `GET /v1/shopify/analytics` with a
  400-day range ceiling.
- Retention sweeps events past a fixed 400 days, outside the per-store loop so a
  store with no retention settings is still swept.
- Widget instrumentation: five fire points, fire-and-forget, `keepalive` on so
  navigating to /cart cannot cancel the add-to-cart event.
- Analytics page: presets + custom date picker, six stat tiles, hand-rolled SVG
  bar charts on Polaris tokens, table views, product table.

**Failed / Not Done**
- Revenue, order counts and purchase conversion remain out of scope — they need
  `read_orders`, which requires Shopify app review, brings protected-customer-
  data obligations, and forces every merchant to re-consent. Its own spec.
- Widget instrumentation has no automated test; the theme extension has no test
  runner. Verified against a dev store per the plan's checklist.

**Open Questions / Decisions**
- The rate metric is named "Add-to-cart rate" everywhere, never "Conversion
  rate" — it measures a click in a modal, not a sale. When `read_orders` lands,
  that metric earns the word.
- The funnel is never clamped monotonic. Client-side steps are lossy and hiding
  that would hide that they under-report.
- Live queries, no rollup table. Revisit only when a real store is measurably
  slow; the endpoint's response shape would not change.
```

- [ ] **Step 3: Run the full verification**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @tryme/shopify-admin test
pnpm --filter @tryme/api test -- shopify-events
pnpm --filter @tryme/api test -- shopify-refusal-events
pnpm --filter @tryme/api test -- shopify-analytics
pnpm --filter @tryme/dispatcher test -- shopify-events-retention
pnpm --filter @tryme/shopify-admin build
```

Run the API test files individually, **not** the whole integration suite: it has
a known pre-existing Redis rate-limiter 429 cascade when every file runs
together, unrelated to this work.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/progress.md
git commit -m "docs(shopify): record analytics implementation"
```

---

## Verification Checklist

- [ ] `pnpm typecheck` and `pnpm lint` clean across the workspace.
- [ ] All four new test files pass when run individually.
- [ ] `pnpm --filter @tryme/shopify-admin build` succeeds.
- [ ] `psql "$DATABASE_URL" -c "\d shopify_widget_events"` shows all three named indexes plus the primary key.
- [ ] `psql "$DATABASE_URL" -c "\d jobs"` shows `jobs_shopify_store_created_idx`.
- [ ] Dev store: all five event types appear in `shopify_widget_events` after a full try-on.
- [ ] Dev store: blocking the event endpoint in devtools does not break a try-on.
- [ ] Dev store: re-viewing a past result from history does **not** emit a second `result_view`.
- [ ] Analytics page: a day with no try-ons renders as an empty slot in the chart, not a skipped column.
- [ ] Analytics page: no label anywhere reads "Conversion rate".
- [ ] Chart bars are legible against the card surface in both light and dark admin themes.
