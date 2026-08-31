# GST invoice for individual credit purchases — design spec

## Context

Individual users buying credit top-ups on `apps/catalogues-web`'s pricing
page already pay GST — `POST /v1/payments/orders`
(`apps/api/src/modules/payments/routes.ts:184-235`) computes
`gstPaise = basePaise * 0.18` and `totalPaise = basePaise + gstPaise`, and
these are stored on the `payments` row
(`packages/db/src/schema/credits.ts:23-39`). The pricing page's marketing
copy already promises "GST invoice available"
(`apps/catalogues-web/src/app/(app)/catalogues/[id]/preview/templates.tsx:2417`),
but no invoice is ever actually generated — there is no invoice concept
anywhere in the codebase (confirmed via repo-wide search). Customers cannot
supply a GSTIN, and even if they could, there'd be nothing to attach it to.

This spec adds: a GSTIN field the customer can set at checkout or store on
their profile, a legally-numbered PDF GST invoice generated after a
successful payment, and delivery of that invoice via download (payment
history) and email.

**Scope**: individual user credit purchases only (the `payments` table /
`apps/api/src/modules/payments/routes.ts` flow). The separate merchant
plan-billing flow (`merchantPayments` table,
`apps/api/src/modules/merchant/payments.routes.ts`) is explicitly out of
scope for this spec.

## Goals

- Customer can optionally set/edit a GSTIN on their profile
  (`apps/catalogues-web` Settings), reused as a checkout pre-fill.
- Every purchase goes through a new confirmation screen (pre-Razorpay) that
  shows the GSTIN field (pre-filled from profile, independently editable per
  purchase) and the Subtotal/GST/Total breakdown, before proceeding to the
  existing Razorpay checkout widget.
- After a successful payment, a sequentially-numbered PDF GST invoice is
  generated, stored in R2, and made available for download from payment
  history and sent as an email attachment.
- Company (seller) GST registration details are admin-configurable, not
  hardcoded.
- Invoice generation is fully non-fatal — it can never block or fail a
  payment/credit-grant.

## Non-goals

- Merchant plan-billing invoices (separate spec if/when needed).
- GSTIN checksum validation (format-regex only, per product decision).
- Editable/re-issuable invoices, credit notes, or invoice cancellation flows.
- Automatic retry of a failed invoice generation (out of scope — a payment
  succeeding without an invoice is an acceptable, rare edge case for now).

## Data model

### `users` (add column)

- `gstin` (`text`, nullable) — editable via the existing `PATCH /v1/me`
  (`apps/api/src/modules/auth/routes.ts:585-...`), returned by `GET /v1/me`.
  Validated with the same GSTIN format regex used at checkout.

### `payments` (add column)

- `gstin` (`text`, nullable) — captured at order-creation time
  (`POST /v1/payments/orders`), independent of `users.gstin`: pre-filled
  from the user's profile value when present, but editing it at checkout
  does **not** write back to the profile. This is the value that appears on
  that specific invoice.

### `invoices` (new table)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `paymentId` | uuid FK → `payments.id`, **unique** | one invoice per payment; the uniqueness constraint is what makes `issueInvoiceIfNeeded` idempotent |
| `invoiceNumber` | text, unique | e.g. `INV-2025-26-000001` |
| `r2Key` | text | stored PDF |
| `issuedAt` | timestamptz | |

### `invoice_sequences` (new table)

| Column | Type | Notes |
|---|---|---|
| `financialYear` | text PK | e.g. `"2025-26"`, Apr 1–Mar 31 |
| `nextNumber` | integer | incremented transactionally |

Numbering: `UPDATE invoice_sequences SET next_number = next_number + 1 WHERE
financial_year = $1 RETURNING next_number - 1`, inside the same transaction
as the `invoices` insert. This is the mechanism that keeps numbers
gap-free and race-safe under concurrent purchases — a `COUNT(*)`-based
scheme would not guarantee that under concurrency. If no row exists yet for
the current financial year, insert one with `nextNumber = 1` first
(`ON CONFLICT DO NOTHING` then re-select, to stay race-safe on the very
first invoice of a new financial year too).

### Admin config (existing table, new fields)

Add to the existing admin-configurable settings (`GET`/`PATCH
/admin/config`):

- `sellerGstin` (text)
- `sellerLegalName` (text)
- `sellerAddress` (text)

These are the "seller" block on every invoice. Surfaced in `apps/admin-web`
Settings.

## Backend flow

### GSTIN validation

Shared Zod refinement / regex, used at both `PATCH /v1/me` and
`POST /v1/payments/orders`:

```
/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
```

(Standard 15-character GSTIN pattern: 2-digit state code, 10-char PAN,
1-digit entity code, literal `Z`, 1 checksum char — format only, no
checksum computation per the non-goals above.) Malformed GSTIN → 400 with a
clear error message. Empty/absent is always valid (the field is optional).

### `POST /v1/payments/orders`

Body gains optional `gstin: z.string().optional()`. Validated if present.
Stored on the new `payments.gstin` column alongside the existing
`basePaise`/`gstPaise` write — no other change to this route's logic.

### Invoice issuance — `issueInvoiceIfNeeded(paymentId)`

New shared helper in the payments module. Called non-fatally (fire-and-forget,
same pattern as the existing `maybeSendReceipt`) from **both** places that
can be the one to actually credit a payment:

- `POST /v1/payments/verify`'s success branch (primary path)
- The webhook's `payment.captured` branch (fallback path)

Both call sites must be safe to invoke even if the other already ran (only
one is expected to fire per payment, but they race in principle). Safety
comes from the `invoices.paymentId` unique constraint: the insert uses
`ON CONFLICT (payment_id) DO NOTHING`, so a second concurrent call is a
harmless no-op rather than a duplicate invoice / double-consumed sequence
number. (The sequence increment is inside the same transaction as the
conflict-checked insert, so a losing racer's sequence allocation is never
persisted either.)

Steps inside `issueInvoiceIfNeeded`:

1. Load the payment row (must be `status = 'paid'`) and the current admin
   config seller fields.
2. Allocate the next invoice number for the current financial year (see
   Data model above).
3. Render the PDF via `pdfkit` — seller block (from admin config), customer
   block (email, GSTIN if present), line items (plan name, `basePaise`,
   `gstPaise`, `totalPaise`), invoice number, issue date.
4. Upload the rendered buffer to R2 via the existing `StorageProvider`
   (`packages/storage`), under a new key builder in `packages/storage/src/keys.ts`
   (e.g. `invoices/{paymentId}.pdf`).
5. Insert the `invoices` row (`ON CONFLICT DO NOTHING` as above).
6. On any failure in steps 1–5: log and swallow. Never throws to the caller.

### Email

Extend the existing `sendPaymentReceiptEmail` (Resend,
`apps/api/src/lib/mailer.ts`) call to attach the generated PDF — Resend's
SDK already supports `attachments`. Triggered once `issueInvoiceIfNeeded`
successfully produces a PDF buffer; still fire-and-forget/non-fatal, same as
today.

### `GET /v1/payments/history`

Extended to also return, per row: `invoiceNumber` (nullable) and a
presigned R2 GET URL (nullable) — `null` when no invoice exists yet (e.g.
issuance still in flight, or it failed and was never retried).

### `GET /v1/payments/:id/invoice` (new)

Auth-gated (`requireUser`), 403 if the payment doesn't belong to the caller,
404 if no invoice exists yet. Redirects to (or streams) the stored PDF.
Exists as a stable, re-fetchable link independent of the presigned URL's
expiry.

## Frontend

### Settings / profile (`apps/catalogues-web/.../settings/page.tsx`)

New `gstin` field, following the exact existing `companyName` pattern
(state, `me?.gstin` fallback, trim-or-null on save, included in the
`PATCH /v1/me` body). Client-side format validation before submit, same
regex as the backend.

### Checkout confirm modal (new component)

Inserted into `use-pricing-data.ts`'s `startBuy`/`buy` flow
(`apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts`). Shown for
**every** purchase — chained after the existing coupon modal when that also
applies (first-time, non-attributed buyers see coupon modal → this modal →
Razorpay; everyone else sees this modal → Razorpay directly).

- Pre-fills GSTIN from `GET /v1/me`'s `gstin`, independently editable.
- Shows Subtotal/GST/Total using the existing `displayBase`/`displayTax`/
  `displayTotal` helpers already in this file.
- "Pay ₹{total}" button proceeds into the existing `loadRazorpay()` →
  `POST /v1/payments/orders` → widget-open flow, now passing the (possibly
  edited) `gstin` into the order-creation call.
- Matches the visual design from the provided mockup; built with the
  existing `C` design tokens (`apps/catalogues-web/src/components/tokens.ts`)
  and the pink→amber `grad` gradient for the Pay button, per this repo's
  "never use raw hex" convention.

### Payment history (Settings page, existing list)

Add a "Download Invoice" link per row, shown only when `invoiceNumber` /
download URL is present from `/v1/payments/history`. No link shown
otherwise (payment still succeeded either way).

### Admin Settings (`apps/admin-web`)

New fields for `sellerGstin` / `sellerLegalName` / `sellerAddress` in the
existing config settings view, following that view's existing field
patterns.

## Error handling

- Malformed GSTIN → 400, both at `PATCH /v1/me` and
  `POST /v1/payments/orders`. Frontend surfaces the message inline under the
  field, doesn't block the rest of the form.
- Invoice generation failure (PDF render, R2 upload, or DB error) never
  blocks the payment/credit grant — logged and swallowed, identical in
  spirit to the existing `maybeSendReceipt` non-fatal pattern.
  `/history` simply shows no download link until/unless it succeeds.
- Email attachment failure: same non-fatal treatment as the existing receipt
  email failure path.

## Testing

- Unit: GSTIN regex validation (valid examples, malformed examples, empty
  string).
- Integration (extending the existing payments test suite):
  - Order creation with and without `gstin` in the request body.
  - `issueInvoiceIfNeeded` produces a unique, sequential invoice number
    within a financial year.
  - `issueInvoiceIfNeeded` is idempotent under double-invocation (simulates
    the verify+webhook race) — exactly one `invoices` row and one sequence
    number consumed.
  - A payment that fails invoice generation (e.g. forced R2 failure) still
    ends up `status = 'paid'` with credits granted.

## Rollout

Implemented on `dev` first (PR per normal branch policy), verified, then
the same commit(s) cherry-picked onto a `main`-based branch and PR'd
directly into `main` — mirroring the approach just used for the flat-saree
prompt-override fix — so this ships to both the `dev`→staging and
`main`→production deploy targets without bundling in the ~188 other commits
currently ahead of `main` on `dev`.
