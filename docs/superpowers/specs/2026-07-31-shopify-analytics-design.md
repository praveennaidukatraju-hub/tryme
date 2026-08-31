# Shopify Analytics — Design

**Date:** 2026-07-31
**Status:** Approved
**Depends on:** `docs/superpowers/plans/2026-07-31-shopify-shopper-limits.md` (landed through Task 5) and `docs/superpowers/plans/2026-07-31-shopify-widget-design.md` (must ship first)

---

## Problem

A merchant who installs the try-on app has no way to tell whether it is doing
anything. The Dashboard shows a lifetime try-on count and product sync status;
there is no time dimension, no per-product breakdown, and no signal about
whether try-ons lead anywhere.

## Goals

Answer, for a date range the merchant chooses:

1. How much is the widget being used, and is that going up or down?
2. Which products get tried on, and which of those lead to an add to cart?
3. Where do shoppers drop out of the flow?
4. How many shoppers am I turning away with my own limits?
5. How many emails have I captured?

These are **merchant business metrics**. Backend operational metrics —
generation duration, worker health, failure/retry rates — are explicitly out of
scope; those belong in the internal admin panel, not a store owner's page.

## Non-Goals

- **Revenue, order counts, and purchase conversion.** These need the
  `read_orders` scope, which requires Shopify app-review approval, brings
  protected-customer-data obligations, and forces every installed merchant
  through re-consent. It also needs an attribution model ("a shopper who tried
  on product X then ordered it within N days") that is a product decision, not a
  query. Its own spec, designed once this ships.
- **A rollup/aggregation table.** Live queries until a real store is measurably
  slow.
- **Merchant-configurable event retention.** Fixed at 400 days.
- **Benchmarks against other stores.**

## What Already Exists

| Signal | Where | Cost |
|---|---|---|
| Try-on counts, timestamps, shopper linkage | `jobs.shopify_store_id`, `.shopify_shopper_id`, `.created_at` | Free |
| Which product a try-on was for | `job_inputs.params->>'shopifyProductId'` | Free (PK join) |
| Shopper identity | `shopify_shoppers.client_id` | Free |
| Captured emails | `shopify_shoppers.email`, `.email_captured_at` | Free |
| Store timezone | `shopify_stores.iana_timezone` + `store-day.ts` helpers | Free |
| Refusals and their reasons | Decided in `limits.ts`, not persisted | 3 inserts |
| Button clicks, uploads, result views, add-to-carts, shares | Nothing | New table + endpoint |

`shopify.app.toml` requests `read_products,write_products`. Registered webhook
topics are `app_uninstalled`, `products_update`, `products_delete`, the GDPR
trio, and `app_subscriptions_update`. There is no order data and no path to it
without the scope change described under Non-Goals.

---

## 1. Event Ingestion

### Table

```ts
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
    // Server-written by limits.ts, unforgeable:
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

**`bigserial`, not `uuid` — a deliberate break from repo convention.** Every
other table uses `uuid().defaultRandom()`. On an append-only table with the
highest write rate in the system, random UUIDs scatter B-tree inserts across the
whole index and fragment it; a monotonic key appends to one page. This table has
no cross-service references and no need for an unguessable id, so the reason the
convention exists does not apply here.

A second index is required on an existing table: `jobs (shopify_store_id,
created_at)`. Today there is only the plain foreign key, and every query in this
spec filters on exactly that pair.

### Endpoint

`POST /v1/shopify/customer/event`, behind the existing `app.requireShopifyStoreKey`
plugin like every other storefront route, so it is store-scoped and
origin-checked.

Body: `{ type, clientId?, shopifyProductId?, device? }`. `type` is validated
against the client-reportable set only — the `refused_*` types are rejected from
this endpoint, so a shopper cannot manufacture refusals that never happened.

**Rate limiting gets its own budget.** The existing `checkRateLimit` helper in
`customer.routes.ts` allows 60/min *per store* — correct for job creation, far
too tight here, where one busy store produces hundreds of events a minute. A
separate limiter keyed `shopify:events:rl:{storeId}` at a much higher ceiling.
Events over the limit are **dropped with a 204, not a 429**. Analytics must never
break a shopper's try-on; a lost event is acceptable, a failed request in the
widget's hot path is not.

**Events are advisory and never trusted for anything that matters.** No credit
decision, no limit check, no authorization reads this table. The worst case for
a forged flood is a wrong chart, and the rate limiter bounds that.

### Server-written refusal events

`limits.ts` already knows the moment a shopper is turned away and why. Three
inserts there produce the `refused_*` rows, each wrapped so a failed analytics
write can never turn a soft refusal into a 500 — the shopper's experience must
not depend on our bookkeeping.

### Generation events are not stored

`jobs` already carries store, shopper, and timestamp. A duplicate event row
would create a second source of truth for the same number.

### Retention

The hourly sweeper the shopper-limits spec adds to the dispatcher gains a fourth
pass, deleting events older than a fixed **400 days**. Fixed rather than
merchant-configurable: 400 days covers an "all time" range plus year-over-year
comparison, and a merchant who shortened it would silently destroy their own
history.

---

## 2. Metrics

All day boundaries are **store-local**, reusing `iana_timezone` and the helpers
in `store-day.ts`. A merchant reading "Tuesday: 47 try-ons" means their Tuesday.
Bucketing is `date_trunc('day', created_at AT TIME ZONE $tz)`.

Per-product try-ons need **no expression index on the JSONB**: the query filters
`jobs` by store and date range first, then joins `job_inputs` on `job_id`, which
is that table's primary key. The `params->>'shopifyProductId'` extraction runs
only on the already-narrowed set.

### Cards

| Card | Definition |
|---|---|
| Try-ons | `count(jobs)` where `shopify_store_id = $1` and `created_at` in range |
| Unique shoppers | `count(distinct shopify_shopper_id)` over the same rows |
| Added to cart | `count(distinct client_id)` with an `add_to_cart` event in range |
| Add-to-cart rate | Added to cart ÷ the funnel's `tryOn` step — i.e. `count(distinct client_id)` reached through `jobs → shopify_shoppers` in range. Deliberately **not** the try-ons card, which counts jobs and includes shoppers with no `client_id`; dividing a client-id-keyed numerator by that denominator would understate the rate |
| Emails captured | `count(shopify_shoppers)` with `email is not null` and `email_captured_at` in range |
| Turned away | `count(*)` of `refused_*` events in range, broken out by reason |

**The rate card is named "Add-to-cart rate", never "Conversion rate".** A
merchant reads "conversion" as *purchased*. This measures a click on a button
inside a modal — a real signal, but not a sale. Calling it conversion would have
merchants comparing it against their storefront conversion rate and concluding
the app is either miraculous or broken. The per-product column carries the same
name. When `read_orders` lands, that metric earns the word.

**Rates count shoppers, not events.** A shopper who clicks Add to Cart three
times is one. Event-based counting would let one enthusiastic shopper push a
product past 100%.

### Funnel

Each step is **distinct `client_id` reaching that step within the range** — not
raw event counts, which would put uploads above clicks and make the chart look
broken.

```
button_click  → distinct client_id, events
upload        → distinct client_id, events
try-on        → distinct client_id via jobs → shopify_shoppers
result_view   → distinct client_id, events
add_to_cart   → distinct client_id, events
```

**The funnel is not forced monotonic, and the page says so.** A shopper running
an ad blocker that eats the event endpoint still generates a real try-on, so step
3 can legitimately exceed step 1. Clamping each step to the one above would hide
that the client events are lossy — exactly what a merchant needs to know before
trusting the top of the funnel. A note under the chart reads:

> Steps 1, 2, 4 and 5 are measured in the shopper's browser and can be blocked.
> Try-ons are measured on our servers and are exact.

### Shoppers with no `client_id`

Widget versions predating shopper identity send none. Those jobs count toward
**try-ons** and **unique shoppers** but cannot appear in the funnel or the
add-to-cart rate, because there is no id to join on. Rather than under-report
silently, the API returns an `unattributed` count alongside the funnel and the
page shows it when non-zero.

### Daily series

One series — try-ons per store-local day, rendered as **vertical bars**
(discrete daily counts, not a continuous quantity). **Zero-filled** across the
range so a quiet day renders as an empty slot at zero rather than being skipped
and distorting the x-axis.

### Per-product table

Columns: product, try-ons, unique shoppers, added to cart, add-to-cart rate.
Sortable on any column, so "most tried on" and "best converting" are each one
click. Titles come from `shopify_product_garments.title` joined on `(store_id,
shopify_product_id)` — no Shopify API call.

---

## 3. API

`GET /v1/shopify/analytics?from=&to=` behind `app.requireShopifySession`.

```ts
{
  range: { from, to, timezone },
  cards: {
    tryOns: number,
    uniqueShoppers: number,
    addedToCart: number,
    addToCartRate: number,          // 0..1
    emailsCaptured: number,
    turnedAway: { total, storeCap, shopperCap, emailGate },
  },
  daily: [{ day: '2026-07-01', tryOns: 12 }],   // zero-filled, store-local
  funnel: {
    buttonClick, upload, tryOn, resultView, addToCart,
    unattributed,                    // try-ons with no client_id
  },
  products: [
    { shopifyProductId, title, tryOns, uniqueShoppers, addedToCart, addToCartRate },
  ],
}
```

`from` and `to` are ISO dates, validated `to >= from` and **capped at 400 days**
to match the events retention horizon — a wider range would return a window
partly swept clean, which reads as a traffic collapse rather than as missing
data. Default is the last 30 days.

**Presets are resolved client-side into `from`/`to`**, so the server has one code
path. "All time" resolves to `store.installedAt`, clamped to the 400-day cap.

---

## 4. Page

New page at `/analytics` in `apps/shopify`, nav order
Dashboard → Manage → **Analytics** → Widget Design → Settings → Support.

Polaris `Page` titled Analytics. The date control is a `Popover` holding an
`OptionList` of presets (7 / 30 / 90 days, All time) beside a `DatePicker` with
`allowRange` — Polaris 13 ships no combined range picker, so it is assembled from
those two. Filters sit in one row above the charts.

The KPI row is an `InlineGrid` of stat tiles. Per the dataviz skill these are
**not charts** — a headline number with a label, no sparkline, no decoration.

### Charts — hand-rolled inline SVG, no chart library

`apps/shopify` has no charting dependency. Adding `@shopify/polaris-viz` pulls a
large tree and its own provider for two charts; both charts here are
single-series magnitude, roughly 60 lines of SVG each. The daily series is
vertical bars, the funnel is horizontal bars — the same mark, two orientations,
so one small SVG bar primitive serves both.

**Colors come from Polaris tokens, not from the dataviz skill's default
palette.** That is the skill's documented "plug in a design system" path: Polaris
is the design system, it supplies the ramps, and using its tokens means the
charts follow the Shopify admin's dark mode automatically rather than needing a
hand-picked second palette. Both charts are single-series, so no categorical
palette exists to validate; what does apply is the **contrast check of bar fill
against chart surface, in both light and dark**, run at implementation.

Single series also means **no legend** — the chart title names the series.
Labels are selective, never a number on every bar. Both charts get hover
tooltips; the skill treats that as default, not an enhancement.

**The funnel is horizontal bars, not a tapered funnel graphic.** A tapered funnel
encodes each step as an area that narrows, which *assumes* every step is smaller
than the one above it. §2 establishes that ours is legitimately non-monotonic. A
tapered shape would have to either lie about that or render as a visual
impossibility. Plain horizontal bars on a shared scale show it truthfully.

**Accessibility.** Each chart has a table view behind a disclosure, so the data
is reachable without reading the graphic. The per-product table already covers
products; this adds equivalents for the daily series and the funnel.

### Captured emails stay on Settings → Data

The shopper-limits spec puts the email list and CSV export on Settings → Data,
where the GDPR controls live. Duplicating the list here would mean two places to
delete a shopper from. Analytics shows the **count** and links across.

---

## 5. Widget Instrumentation

One helper in `tryon-widget.js`:

```js
function trackEvent(type, productId) {
  try {
    fetch(`${apiBase}/v1/shopify/customer/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, clientId, shopifyProductId: productId, device }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break a try-on */
  }
}
```

Never awaited, never surfaced to the shopper. `keepalive: true` matters for
`add_to_cart`, where the shopper may navigate to the cart before the request
settles.

| Fire point | Event |
|---|---|
| Modal opens | `button_click` |
| File accepted | `upload` |
| `showStep('result')` | `result_view` |
| `/cart/add.js` succeeds | `add_to_cart` |
| Share button clicked | `share` |

`device` is `window.innerWidth < 768 ? 'mobile' : 'desktop'` — a heuristic, and
labeled as one in the UI rather than presented as device detection.

---

## 6. Testing

**`apps/api/test/shopify-analytics.test.ts`** — seed jobs and events across
several store-local days, then assert:

- Card values match the seeded data.
- The daily series zero-fills a quiet day rather than omitting it.
- Funnel steps count distinct `client_id`, not raw events — seed one shopper with
  three `button_click` rows and expect 1.
- Per-product aggregation and ordering.
- A range over 400 days is rejected with 400.
- **Store isolation** — a second store's jobs and events never appear in the
  first store's numbers.
- Day bucketing follows the store's timezone, not UTC.

**`apps/api/test/shopify-events.test.ts`** — the ingest endpoint:

- Rejects a missing or wrong store key.
- Rejects an unknown `type`.
- Rejects a `refused_*` type submitted by a client.
- Returns 204 and writes nothing once over the rate limit.
- Accepts a payload with no `clientId` without erroring.

**`apps/shopify` vitest** (the runner the Widget Design spec adds) — the
preset→`from`/`to` resolver is a pure function; unit-test the four presets and
the store-local boundary.

---

## 7. Sequencing

Depends on **shopper-limits**, landed through its Task 5: `client_id`,
`shopify_shoppers`, `limits.ts`, `store-day.ts`.

Depends on **Widget Design shipping first**, for two reasons:

1. `add_to_cart` cannot fire until that button exists, so the add-to-cart rate
   would be structurally zero.
2. The instrumentation edits `tryon-widget.js` and the block Liquid — the same
   files Widget Design rewrites, and the block file it deletes. Building
   Analytics first would mean writing instrumentation into a file already
   scheduled for deletion.

It also inherits the vitest setup that the Widget Design plan adds to
`apps/shopify`.
