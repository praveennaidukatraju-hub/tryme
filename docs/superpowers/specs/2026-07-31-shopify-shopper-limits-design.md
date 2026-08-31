# Shopify Shopper Limits, Email Capture & Retention — Design

**Date:** 2026-07-31
**Status:** Approved, ready for implementation planning
**Supersedes/extends:** `2026-07-30-shopify-app-restructure-design.md`

## Problem

A Shopify try-on spends the merchant's own TryMe credits (`atomicDeduct`,
`apps/api/src/modules/shopify/customer.routes.ts`). The only guard in front of
that spend today is a 60-requests-per-minute-per-store Redis bucket
(`shopify:customer:rl:{storeId}`, `customer.routes.ts:28`). That is a burst
limiter, not a spend ceiling.

Consequences as it stands:

- One shopper, or one script, on a public product page can run try-ons
  continuously at 60/min against a merchant's balance until it reaches zero.
- When the balance empties, every genuine shopper on that store gets an
  out-of-credits error (`requireStoreOwnerWithCredits`, `customer.routes.ts:61`).
- Nothing tells the merchant it is happening.
- There is no shopper identity of any kind. The widget authenticates with
  `X-Widget-Key` = `store.storeKey`, a UUID rendered into public page HTML and
  identical for every shopper. History and photo reuse are `localStorage` only
  (`tryon-widget.js:48`, `:64`) — the server knows nothing about who is asking.

This becomes more pressing as the Manage page gains bulk activation: enabling
try-on across an entire catalogue multiplies the exposed surface.

## Goals

1. Give the merchant a spend ceiling that actually holds — one that cannot be
   bypassed from the browser.
2. Give the merchant softer per-shopper controls, honestly labelled as
   friction rather than as guarantees.
3. Let the merchant capture shopper emails, with valid consent, and export them.
4. Delete shopper PII on a schedule, and make the GDPR webhooks truthful.

## Non-Goals

- No platform-imposed ceiling. Limits are the merchant's decision; we impose
  none and clamp nothing. Every limit is **Off unless the merchant turns it on**.
- No billing/plan system. Shopify installs spend TryMe credits; top-up
  happens at app.tryme.com. Anything in earlier drafts about plan quotas,
  reset dates, or upgrade CTAs is out of scope permanently.
- No external login for shoppers. A shopper must never see an TryMe login.
- No App Proxy migration (deferred, see below).
- No push of captured emails into Shopify customer records (deferred).

## Prior Assumptions Corrected During Design

Recorded so they are not re-litigated:

- **`allowedOrigins` is already populated at install.** `auth.routes.ts:42-45`
  sets it to `[https://{myshopifyDomain}, https://{primaryDomain}]` on every
  OAuth install and reinstall. An earlier draft proposed "default the origin
  allowlist" as work; there is nothing to build. Note also that an `Origin`
  header is only enforced by browsers — a script sends whatever it likes — so
  the allowlist was never a spend control.
- **An admin/platform ceiling was considered and rejected** by the product
  owner: capping the merchant is the merchant's call, not ours.

## Approach

Server-authoritative. Redis holds hot counters; Postgres holds durable truth.
The widget never enforces anything — it renders whatever refusal the server
returns. No limit settings are ever pushed to the storefront, so nothing can go
stale and nothing advertises a merchant's limits until they are hit.

Two alternatives were considered and rejected:

- **Everything in Postgres** (no Redis in the limit path): durable and single
  mental model, but the store-cap path is the hot one and would pay an indexed
  count per request, plus hand-rolled day bucketing and cleanup instead of free
  TTLs.
- **Widget-enforced with settings pushed via shop metafield**: fastest UI, but
  two enforcement points that must agree, settings that go stale between
  metafield writes, and merchant limits published into public page HTML.

The chosen shape also reuses patterns already in the codebase (the
`shopify:customer:rl:` Redis key shape, `config:system` for global defaults,
the dispatcher `setInterval` sweeper) and the `shopify_shoppers` +
`jobs.shopify_shopper_id` model is the same foundation a later Analytics
feature needs for per-shopper funnels and repeat-visitor rates.

## Data Model

### New table: `shopify_shoppers`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `store_id` | uuid NOT NULL | FK `shopify_stores`, `ON DELETE CASCADE` |
| `client_id` | text NOT NULL | anonymous UUID minted by the widget, held in localStorage |
| `shopify_customer_id` | bigint NULL | from Liquid `customer.id` when the shopper is logged into the merchant's store |
| `email` | text NULL | captured via the gate, or prefilled from Liquid |
| `email_consent` | boolean NOT NULL default false | explicit marketing opt-in |
| `email_captured_at` | timestamptz NULL | |
| `first_seen_at` | timestamptz NOT NULL default now() | |
| `last_seen_at` | timestamptz NOT NULL default now() | drives record retention |

- Unique index on `(store_id, client_id)`.
- Index on `(store_id, email)` and `(store_id, shopify_customer_id)`.

### `jobs` change

Add `shopify_shopper_id uuid NULL` → FK `shopify_shoppers(id)` **`ON DELETE SET
NULL`**. Retention and GDPR erasure delete shopper rows; `jobs` rows are billing
records tied to a credit deduction and a ledger entry and must survive with the
link severed. A cascade here would delete billing history.

### `shopify_stores` changes

- Add `iana_timezone text NULL` — the store's local timezone, for day
  bucketing. Available from the same `shop.json` response already fetched at
  install (`auth.routes.ts:163`); one extra destructured field.
- Extend the `settings` JSONB (`ShopifyStoreSettings` in
  `packages/db/src/schema/shopify.ts`):

```ts
limits?: {
  storeDailyCap?: number | null;      // null = off
  perShopperCap?: number | null;      // null = off
  perShopperWindow?: 'day' | 'week' | 'month';
  emailAfterNTryOns?: number | null;  // null = never ask, 0 = always ask
};
retention?: {
  shopperPhotoDays?: number | null;   // null = off
  resultDays?: number | null;         // null = off
  shopperRecordDays?: number | null;  // null = off
};
```

- **Remove the dead fields** `buttonText`, `buttonColor`, `position`,
  `customCss` from `ShopifyStoreSettings`. Verified: nothing reads any of them.
  All widget appearance lives in the theme block's `{% schema %}`
  (`tryon-block.liquid`). Adding nested config beside four dead fields invites
  someone to wire them up later by mistake.

## Shopper Identity

**Row identity and counting identity are deliberately different.**

- **Row identity is always `(store_id, client_id)`.** One row per browser. No
  merge logic, ever.
- **Counting identity is the strongest signal available**, resolved per
  request in precedence order: `shopify_customer_id` → `email` → `client_id`.
  Counting queries span **all rows in the store sharing that signal**.

A shopper who clears localStorage gets a fresh row, but if they have supplied an
email or are logged in, the new row still counts against the same bucket.
Supplying identity can only ever tighten a shopper's limit, never loosen it —
the right incentive, and it makes email capture materially strengthen the
per-shopper cap rather than merely being lead-gen.

**Acknowledged limit:** a fresh browser with no email and no login is a fresh
bucket. That is unfixable at this layer. The store daily cap is what holds
there.

### Client-side

1. On load the widget reads `tryme_client_id` from localStorage, else mints
   one with `crypto.randomUUID()` and stores it — the same storage pattern
   already used for history and photo reuse.
2. The theme block Liquid emits, when `customer` is present:
   ```liquid
   {%- if customer -%}
     data-customer-id="{{ customer.id }}"
     data-customer-email="{{ customer.email }}"
   {%- endif -%}
   ```
   This needs no scope and no Admin API call. Resolving a customer ID to an
   email through the Admin API would require `read_customers`, which is both a
   scope change forcing every existing merchant to re-consent and Shopify
   protected customer data requiring separate approval.
3. The widget sends the client ID (and customer ID / email when known) on
   `/presign`, `/photo/preview`, and `/jobs`.
4. The server calls `resolveShopper(storeId, {...})`, which upserts the row,
   stamps `last_seen_at`, and returns its id.

All three inputs are client-supplied and forgeable. That is acceptable because
forging them cannot loosen a limit — the worst an attacker achieves is joining
a stricter bucket. **No authorization decision depends on them.**

## Enforcement

### Placement in the request pipeline

`POST /v1/shopify/customer/jobs` today runs: store-key auth → 60/min rate limit
→ credit precheck → photo ownership → size check → garment lookup → workflow
resolve → transaction (insert job + `atomicDeduct`) → XADD.

Limits insert **after the garment and workflow checks, immediately before the
transaction**. Rationale: do not spend a limit on a request that was going to
fail anyway, and do not let a limit refusal leak whether a product is enabled.

Order among the three: **email gate → per-shopper cap → store daily cap.**
Most-specific first, so the shopper sees the actionable refusal (supply an
email) rather than a dead end when more than one applies.

**A refusal never consumes quota.** The store-cap counter is *reserved* by the
atomic increment before the transaction and released (`DECR`) on any refusal or
failure downstream of it; the per-shopper count is derived from `jobs` rows,
which exist only after a successful insert. Either way, a shopper bounced to
the email form does not silently lose a try-on.

### Store daily cap — Redis, atomic

Key: `shopify:cap:store:{storeId}:{YYYYMMDD}`.

`INCR`, and if the returned value exceeds the configured cap, `DECR` and refuse.
Increment-then-check, never check-then-increment: the latter lets two concurrent
requests both pass at cap−1. TTL is set to 48h when the counter first reaches 1.

If anything after the increment fails (transaction rollback, enqueue error) the
catch path `DECR`s. A process crash between increment and rollback overshoots
the day by one — acceptable for a spend ceiling, and it fails closed, not open.

**The day boundary is the store's local day**, derived from
`shopify_stores.iana_timezone` via `Intl.DateTimeFormat`. A merchant who sets
"200/day" and watches it reset at 05:30 local will file a bug. Stores with a
null timezone (rows predating the column, until their next reinstall) fall back
to UTC.

### Per-shopper cap — Postgres, not Redis

This asymmetry is deliberate and is the subtlest decision in the design.

A Redis counter must be keyed on the counting identity (`cust:123` / `email:…` /
`client:…`). But identity **upgrades mid-session**: an anonymous shopper who
hits the email gate moves from `client:uuid` to `email:…` — a fresh, empty
bucket. That would hand shoppers a trivial reset: supply an email, get your
quota back. The gate would defeat the cap.

So per-shopper counts come from Postgres: count `jobs` joined to
`shopify_shoppers` for the store, within the calendar window, across **all rows
sharing the counting identity**. Correct across identity upgrades by
construction. It is an indexed count on a far lower-volume path than the store
cap, so the extra query is affordable.

The window is **calendar** (`day` / ISO week / `month`), not rolling — same
reasoning as the day boundary, and a rolling window would need a sorted set per
shopper for no user-visible gain.

### Email gate & consent

`emailAfterNTryOns: N` — the first N generations proceed freely; on N+1 the
server refuses with `email_required`. `N = 0` therefore means the gate fires
before the shopper's first generation; `null` means never ask. The count is the
shopper's successful generations for that store, all time, resolved by counting
identity (not the per-shopper cap's calendar window). The widget renders the email form, the
shopper submits, and the widget **retries the same `/jobs` call** with the email
attached. The uploaded photo is still valid (`shopify:upload:{key}` carries a
600s TTL, `customer.routes.ts:139`), so nothing is re-uploaded.

The form carries a **consent checkbox, unchecked by default**, stored as
`email_consent`. A pre-checked box is not valid GDPR consent. The email is
recorded either way — it is needed to key the cap — but only consented rows are
marketable, and the export marks which is which.

### Refusal contract

Soft refusals keep the existing shape — HTTP 202 with `{ message }`, matching
`customer.routes.ts:223-245` — plus a new `reason` field:

| `reason` | Widget behavior | `message` |
|---|---|---|
| `email_required` | show email form, retry same job call | "Enter your email to continue." |
| `shopper_limit` | terminal message | "You've reached your try-on limit. Check back later." |
| `store_limit` | terminal message | "Try-on isn't available right now." |

`store_limit` is deliberately vague: the storefront must not advertise that the
merchant has a spend cap or where it sits. `shopper_limit` can be specific —
it is the shopper's own limit and telling them is the honest thing.

Keeping 202 rather than a 4xx is deliberate: widget versions already deployed in
the wild ignore unknown fields and render `message`, so they degrade to a
sensible dead end instead of an error screen during rollout.

## Setting Values

All settings are fixed option sets rendered as dropdowns, validated as Zod
enums at the endpoint (an out-of-set value is a 400, not something that lands
silently in JSONB). Fixed sets also eliminate the "2000 instead of 200" typo
class.

| Setting | Options | Pre-selected in UI | Enforced when unset |
|---|---|---|---|
| Per-shopper cap | Off, 1–10 | 5 | **Off** |
| Per-shopper window | Day, Week, Month | Week | — |
| Email after N try-ons | Never, 0 (always), 1, 2, 3, 5 | 2 | **Never** |
| Store daily cap | Off, 50, 100, 250, 500, 1000, 2500, 5000 | 250 | **Off** |

**A dropdown default is not an enforced default.** "Pre-selected" is the value
the dropdown shows when a merchant switches the toggle on. Absent setting means
Off, always — otherwise every existing store would be capped on deploy without
asking, contradicting the non-goal above.

The store daily cap needs a wider spread than the per-shopper cap: a store doing
40 try-ons/day and one doing 3,000 both need a usable number, and a linear 1–10
list cannot serve both.

## Merchant Surface

### New page: `/settings`

A fourth page alongside Dashboard, Manage, and Support, using Polaris `Tabs`:

- **Limits tab** — the four controls above, each behind a toggle. Copy states
  plainly which limits are enforceable: the store daily cap is described as the
  hard ceiling; the per-shopper cap is labelled as reducing casual overuse, not
  as a spend guarantee. A merchant who believes "5 per shopper" protects their
  balance will be angry later; one told the truth sets both.
- **Data tab** — retention controls, the captured-email table, CSV export.

`NAV_ITEMS` in `apps/shopify/src/components/AppNavMenu.tsx` goes from 3 entries
to 4, which flows automatically to both `<ui-nav-menu>` and the dev
`<Navigation>` fallback.

### New endpoint

`PATCH /v1/shopify/settings`, behind `requireShopifySession`, merging into
`shopifyStores.settings` the same way `confirm-theme-block` does
(`onboarding.routes.ts:46`).

### Dashboard usage card

Today's generations against the store cap (when one is set), plus the
captured-email count. Both derive from **Postgres** — `jobs` filtered by
`shopifyStoreId` and the store-local day; `shopify_shoppers` count — not from
the Redis counter, so the number the merchant sees stays correct even if Redis
has been flushed and the guard has lost the day.

### Email list & export

Settings → Data holds a Polaris `IndexTable`: email, consent flag, first seen,
try-on count. CSV export of the same columns. **Consent state is a visible
column, not a hidden field** — the merchant needs to know which addresses they
may legally market to before pasting the list into an email tool.

## Retention

Three independently-configurable classes, each Off by default:

| Class | Target | Options | Pre-selected |
|---|---|---|---|
| Shopper photos | `jobs.customerPhotoKey` (R2 object) | Off, 7, 30, 90 days | 30 |
| Generated results | `job_outputs.resultKey` + `thumbnailKey` (R2) | Off, 30, 90, 180, 365 days | 90 |
| Shopper records | `shopify_shoppers` rows (including email) | Off, 90, 180, 365 days | 365 |

**The `jobs` row itself is never deleted.** It is a billing record tied to a
credit deduction and a ledger entry. Retention deletes the R2 objects and nulls
the key columns; the job, its cost, and its timestamp survive.
`jobs.shopify_shopper_id` is `ON DELETE SET NULL` precisely so purging a shopper
cannot cascade into billing history.

### Sweeper

`runShopifyRetentionSweeper`, driven by `setInterval` in
`apps/dispatcher/src/index.ts` alongside the existing `runSweeper`
(`index.ts:138`), hourly. For each store with retention configured: select
expired rows in bounded batches, delete R2 objects via
`StorageProvider.deleteObject`, null the columns in the same pass.

Idempotent — a null key is skipped, so a crash mid-batch simply re-runs. Failed
R2 deletes are logged and left for the next pass rather than aborting the batch;
one unreachable object must not wedge retention for an entire store.

### Known consequences

Deleting a shopper record nulls `jobs.shopify_shopper_id` on that shopper's past
jobs, so their limit history resets: the email gate will ask again and the
per-shopper cap starts from zero. This is correct — erasure must actually erase
— and the store daily cap is unaffected. Merchants should be told that record
retention shorter than their per-shopper window makes that window ineffective.

The widget's `localStorage` history (`tryon-widget.js:48`) holds result URLs.
Once retention deletes a result, those entries 404. The widget must handle a
dead result gracefully — hide or mark the entry — rather than rendering a broken
image. This is a deliberate side effect of enabling retention, and is in scope.

## GDPR Webhooks

`apps/api/src/modules/shopify/webhook.routes.ts:88-95` currently no-ops
`customers_redact` and `customers_data_request`, justified by comments asserting
*"We store no customer PII beyond transient photos"* and *"no stored customer
data"*. Storing emails makes those comments false and the handlers
non-compliant. Making them real is a correctness requirement of this feature,
not adjacent cleanup.

- **`customers_data_request`** — collect the store's `shopify_shoppers` rows
  matching the payload's customer and log the request with its shopper IDs, for
  the manual response Shopify's 30-day window requires.
- **`customers_redact`** — delete matching shopper rows and their R2 photos and
  results.
- **`shop_redact`** — purge all shopper rows and R2 assets for the store.

Matching is by `shopify_customer_id` first, then `email`: a shopper may have
supplied an email without ever logging in, and the webhook payload carries both.

The stale comments are replaced with accurate ones in the same change.

## Testing

Follows the repo harness — fresh Postgres database and fresh MinIO bucket per
test file, no testcontainers (see CLAUDE.md).

**Integration** (`apps/api/test/integration/`):

- Store cap refuses at N+1, and no credits are deducted on the refused request.
- Per-shopper cap holds **across an identity upgrade** — anonymous → email must
  not reset the count. This is the loophole the Postgres-counting decision
  exists to close.
- Email gate refuses, then succeeds on retry with the same photo key.
- A refusal never consumes quota.
- Retention nulls keys and deletes objects but leaves the `jobs` row and its
  ledger entry intact.
- `customers_redact` removes the shopper row and their R2 objects.

**Unit:**

- Counting-identity resolution precedence.
- Store-local day-bucket key generation across a timezone boundary, including
  the null-timezone UTC fallback.
- Settings Zod enums reject out-of-set values.

The concurrency case (two simultaneous requests at cap−1) is covered by the
atomic `INCR`-then-`DECR` ordering rather than by a flaky parallel test.

**Manual, not automatable:** the widget email-gate flow and `<ui-nav-menu>`
rendering, both of which require a real Shopify admin iframe / storefront.

## Deferred / Future Upgrades

- **Push captured emails into Shopify customer records.** This is what
  merchants ultimately want — the email lands in their own customer list and
  flows into Klaviyo / Shopify Email automatically. Requires the
  `write_customers` scope, which is both a scope change forcing every existing
  merchant to re-consent and Shopify **protected customer data**, gated behind
  an approval process that also gates the app listing. The `shopify_shoppers`
  shape above (email + consent + Shopify customer ID) already supports this;
  the blocker is Shopify's review timeline, not our code.
- **App Proxy migration.** Would give server-verifiable identity via HMAC-signed
  requests carrying `logged_in_customer_id`, retire the public `storeKey` from
  page HTML, and make widget calls same-origin. Note it still yields no identity
  for logged-out shoppers.
- **Merchant notification when a cap is hit.** Today the merchant learns only
  from the Dashboard card, so a capped store stops converting silently until
  they next open the app. An email at the moment of capping is when they would
  most want to top up; it needs throttling so a store at cap daily is not mailed
  daily.
- **Logged-in-customers-only try-on** as a merchant option.
