# GST Invoice for Credit Purchases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer optionally supply a GSTIN (on their profile and/or at checkout) and receive a sequentially-numbered PDF GST invoice, downloadable from payment history and emailed after every successful credit purchase.

**Architecture:** Extend the existing `payments` flow (`apps/api/src/modules/payments/routes.ts`) with a `gstin` field captured at order-creation time; add a non-fatal `issueInvoiceIfNeeded` helper invoked from both credit-granting paths (`/verify` and the webhook) that allocates a gap-free sequential invoice number, renders a PDF with `pdfkit`, uploads it to R2, and records it in a new `invoices` table. Frontend adds a new pre-Razorpay confirmation modal (GSTIN + price breakdown) to `apps/catalogues-web`'s pricing flow, a profile GSTIN field in Settings, and a download link in payment history.

**Tech Stack:** Fastify 5 + Zod (apps/api), Drizzle ORM/Postgres (packages/db), `pdfkit` (new dependency), R2/MinIO via `@tryme/storage`, Resend (email), Next.js 15 + React Query (apps/catalogues-web), Vite + React (apps/admin-web).

## Global Constraints

- Package manager: pnpm workspaces only.
- ESM only (`"type": "module"`) everywhere.
- No `console.log` in committed code — use `@tryme/logger` child loggers.
- Credit deduct/grant + job/payment inserts that must stay consistent go through a single Postgres transaction (existing invariant — this plan does not touch credit-grant transactions, only adds a separate non-fatal step after they commit).
- Never inline-mutate shared JSON structures — `structuredClone` + patch (not directly relevant here, but keep in mind for the PDF renderer's input objects).
- Design tokens: catalogues-web components must use `C`/`grad` from `apps/catalogues-web/src/components/tokens.ts`, never raw hex.
- Tests: Vitest, no testcontainers — `pnpm docker:up` must be running before any integration test run.
- Only commit when a meaningful, tested unit of work is complete (per `docs/version-control.md`).
- Branch policy: feature branch off `dev`, PR into `dev`. This plan's final task also cherry-picks the same commits onto a `main`-based branch per the spec's Rollout section.

---

## Task 1: DB schema — GSTIN columns + invoices/invoice_sequences tables

**Files:**
- Modify: `packages/db/src/schema/users.ts`
- Modify: `packages/db/src/schema/credits.ts`
- Create: `packages/db/src/migrations/0152_gst_invoices.sql` (generated, not hand-written — see steps)

**Interfaces:**
- Produces: `schema.users.gstin` (nullable text), `schema.payments.gstin` (nullable text), `schema.invoices` table (`id`, `paymentId` unique FK → `payments.id`, `invoiceNumber` unique text, `r2Key` text, `issuedAt` timestamptz), `schema.invoiceSequences` table (`financialYear` text PK, `nextNumber` integer).

- [x] **Step 1: Create the feature branch off `dev`**

```bash
git checkout dev
git pull --ff-only origin dev
git checkout -b feat/gst-invoice-credit-purchases
```

- [x] **Step 2: Add `gstin` to `users`**

In `packages/db/src/schema/users.ts`, add one field to the `users` table definition (after `companyName`):

```ts
    companyName: text('company_name'),
    // Optional — customer-supplied GST registration number, editable via
    // PATCH /v1/me. Pre-fills (but does not sync with) the per-purchase
    // gstin captured on `payments` at checkout.
    gstin: text('gstin'),
```

- [x] **Step 3: Add `gstin` to `payments`, and the two new tables in `credits.ts`**

In `packages/db/src/schema/credits.ts`, add `gstin` to the `payments` table (after `credits`, before `status`):

```ts
  credits: integer('credits').notNull(),
  // Optional — captured at order-creation time (POST /v1/payments/orders).
  // Independent of users.gstin: pre-filled from the profile value but
  // editable per purchase without writing back to the profile.
  gstin: text('gstin'),
  status: text('status').notNull().default('created'), // created | paid | failed
```

Then, at the end of the file (after `creditRequests`), add:

```ts
// One row per payment that successfully issued a GST invoice. The unique
// paymentId is what makes issueInvoiceIfNeeded's insert idempotent under
// the verify+webhook race — a second concurrent attempt just no-ops.
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id')
    .notNull()
    .unique()
    .references(() => payments.id, { onDelete: 'cascade' }),
  invoiceNumber: text('invoice_number').notNull().unique(),
  r2Key: text('r2_key').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per Indian financial year (Apr 1 - Mar 31), e.g. "2026-27".
// nextNumber is incremented transactionally (single upsert statement) so
// invoice numbers stay gap-free and race-safe under concurrent purchases.
export const invoiceSequences = pgTable('invoice_sequences', {
  financialYear: text('financial_year').primaryKey(),
  nextNumber: integer('next_number').notNull().default(1),
});
```

- [x] **Step 4: Generate and apply the migration**

Ensure infra is up first (`pnpm docker:up` if not already running), then:

```bash
pnpm db:generate
```

This creates `packages/db/src/migrations/0152_gst_invoices.sql` (or the next free index — check `packages/db/src/migrations/meta/_journal.json`'s last `idx` first; if it's no longer 151, follow the renumbering rule in `docs/version-control.md`). Verify the generated SQL contains `ALTER TABLE "users" ADD COLUMN "gstin"`, `ALTER TABLE "payments" ADD COLUMN "gstin"`, `CREATE TABLE "invoices"`, and `CREATE TABLE "invoice_sequences"`.

```bash
pnpm db:migrate
```

Expected: migration applies cleanly, no errors.

- [x] **Step 5: Rebuild the db package and commit**

```bash
pnpm --filter @tryme/db build
git add packages/db/src/schema/users.ts packages/db/src/schema/credits.ts packages/db/src/migrations/
git commit -m "feat(db): add gstin columns and invoices/invoice_sequences tables"
```

---

## Task 2: Shared GSTIN validation

**Files:**
- Modify: `packages/types/src/credits.ts`
- Test: `packages/types/src/credits.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GSTIN_REGEX` (RegExp, exported), `Gstin` (Zod schema: optional string matching `GSTIN_REGEX` or empty).

- [x] **Step 1: Write the failing test**

Create `packages/types/src/credits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GSTIN_REGEX } from './credits.js';

describe('GSTIN_REGEX', () => {
  it('matches a valid GSTIN', () => {
    expect(GSTIN_REGEX.test('27AAPFU0939F1ZV')).toBe(true);
  });

  it('rejects a malformed GSTIN', () => {
    expect(GSTIN_REGEX.test('not-a-gstin')).toBe(false);
    expect(GSTIN_REGEX.test('27AAPFU0939F1Z')).toBe(false); // too short
    expect(GSTIN_REGEX.test('27aapfu0939f1zv')).toBe(false); // lowercase
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/types test -- credits.test.ts`
Expected: FAIL — `GSTIN_REGEX` is not exported.

- [x] **Step 3: Add `GSTIN_REGEX` to `packages/types/src/credits.ts`**

```ts
import { z } from 'zod';

// Standard 15-char GSTIN: 2-digit state code, 10-char PAN (5 letters + 4
// digits + 1 letter), 1-digit entity code, literal 'Z', 1 checksum char.
// Format only — no checksum computation (product decision, see
// docs/superpowers/specs/2026-08-12-gst-invoice-for-credit-purchases-design.md).
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const Gstin = z
  .string()
  .regex(GSTIN_REGEX, 'Invalid GSTIN format')
  .optional()
  .or(z.literal(''));

export const CreditsResponse = z.object({
  balance: z.number().int().min(0),
  recent: z.array(
    z.object({
      id: z.string().uuid(),
      delta: z.number().int(),
      reason: z.string(),
      createdAt: z.string(),
    }),
  ),
});
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/types test -- credits.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/types/src/credits.ts packages/types/src/credits.test.ts
git commit -m "feat(types): add shared GSTIN format validator"
```

---

## Task 3: Profile GSTIN — GET/PATCH /v1/me

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Test: `apps/api/test/profile-gstin.test.ts` (new)

**Interfaces:**
- Consumes: `Gstin` from `@tryme/types` (Task 2).
- Produces: `GET /v1/me` response includes `gstin: string | null`; `PATCH /v1/me` accepts optional `gstin` in body.

- [x] **Step 1: Write the failing test**

Create `apps/api/test/profile-gstin.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api';
import { type Containers, startContainers } from './helpers/containers';

describe('profile GSTIN', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function registerAndLogin(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: '127.0.0.10',
      payload: { displayName: 'GSTIN User', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    await app.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user.id));
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '127.0.0.10',
      payload: { email, password: 'password123' },
    });
    return loginRes.json().accessToken as string;
  }

  it('saves and returns a valid GSTIN', async () => {
    const token = await registerAndLogin('gstin-valid@x.com');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: '27AAPFU0939F1ZV' },
    });
    expect(patchRes.statusCode).toBe(200);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.json().gstin).toBe('27AAPFU0939F1ZV');
  });

  it('rejects a malformed GSTIN with 400', async () => {
    const token = await registerAndLogin('gstin-invalid@x.com');

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: 'not-a-gstin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows clearing a previously-set GSTIN with an empty string', async () => {
    const token = await registerAndLogin('gstin-clear@x.com');
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: '27AAPFU0939F1ZV' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: '' },
    });
    expect(res.statusCode).toBe(200);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.json().gstin).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- profile-gstin.test.ts`
Expected: FAIL — `gstin` is `undefined` in the `/v1/me` response (PATCH silently ignores the unknown body field today since Zod strips it, so the save is a no-op).

- [x] **Step 3: Wire `gstin` into `GET /v1/me`**

In `apps/api/src/modules/auth/routes.ts`, add `gstin: schema.users.gstin` to the `select` at line ~532-544 (the `GET /v1/me` handler):

```ts
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        phone: schema.users.phone,
        username: schema.users.username,
        companyName: schema.users.companyName,
        gstin: schema.users.gstin,
        tier: schema.users.tier,
        passwordHash: schema.users.passwordHash,
        defaultResolution: schema.users.defaultResolution,
        defaultAspectRatio: schema.users.defaultAspectRatio,
        defaultPlatform: schema.users.defaultPlatform,
      })
```

- [x] **Step 4: Wire `gstin` into `PATCH /v1/me`**

At the top of `apps/api/src/modules/auth/routes.ts`, add the import:

```ts
import { Gstin } from '@tryme/types';
```

(Add it alongside whatever `@tryme/types` import already exists at the top of the file — if there isn't one yet, add a new `import { Gstin } from '@tryme/types';` line near the other imports.)

In the `PATCH /v1/me` route's `body` Zod schema (~line 590-602), add:

```ts
        body: z.object({
          displayName: z.string().min(1).max(60).optional(),
          email: z.string().email().max(254).optional(),
          phone: z
            .string()
            .regex(/^\d{10}$/, 'phone must be a 10-digit number')
            .nullable()
            .optional(),
          companyName: z.string().max(160).nullable().optional(),
          gstin: Gstin,
          defaultResolution: z.enum(['HD', '2K', '4K']).optional(),
          defaultAspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']).optional(),
          defaultPlatform: z.string().max(60).optional(),
        }),
```

In the handler body (~line 606-622), destructure `gstin`:

```ts
      const {
        displayName,
        email,
        phone,
        companyName,
        gstin,
        defaultResolution,
        defaultAspectRatio,
        defaultPlatform,
      } = req.body as {
        displayName?: string;
        email?: string;
        phone?: string | null;
        companyName?: string | null;
        gstin?: string;
        defaultResolution?: string;
        defaultAspectRatio?: string;
        defaultPlatform?: string;
      };
```

In the `tx.update(schema.users).set({...})` call (~line 654-664), add (following the exact `companyName` trim-or-null pattern):

```ts
          .set({
            ...(displayName !== undefined ? { displayName } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(phone !== undefined ? { phone: phone ?? null } : {}),
            ...(companyName !== undefined ? { companyName: companyName?.trim() || null } : {}),
            ...(gstin !== undefined ? { gstin: gstin.trim().toUpperCase() || null } : {}),
            ...(defaultResolution !== undefined ? { defaultResolution } : {}),
            ...(defaultAspectRatio !== undefined ? { defaultAspectRatio } : {}),
            ...(defaultPlatform !== undefined ? { defaultPlatform } : {}),
          })
```

And add `gstin: schema.users.gstin` to that same query's `.returning({...})` block (~line 666-677).

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- profile-gstin.test.ts`
Expected: PASS (all 3 cases)

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/profile-gstin.test.ts
git commit -m "feat(api): let users set/edit their GSTIN on GET/PATCH /v1/me"
```

---

## Task 4: Order creation captures GSTIN

**Files:**
- Modify: `apps/api/src/modules/payments/routes.ts`
- Test: `apps/api/test/integration/payments-tier.test.ts` (extend)

**Interfaces:**
- Consumes: `Gstin` from `@tryme/types` (Task 2), `schema.payments.gstin` (Task 1).
- Produces: `POST /v1/payments/orders` accepts optional `gstin` in body, stores it on the created `payments` row.

- [x] **Step 1: Write the failing test**

No existing test in this repo calls `POST /v1/payments/orders` (confirmed — `apps/api/test` has zero matches for `payments/orders`; every existing payments test seeds a `payments` row directly via DB insert and only exercises `/verify`). This route calls the real Razorpay API (`createRazorpayOrder` in `apps/api/src/modules/payments/routes.ts` does a plain `fetch('https://api.razorpay.com/v1/orders', ...)`), so it must be mocked — follow the exact `vi.spyOn(global, 'fetch')` pattern already used in `apps/api/test/integration/google-oauth.test.ts` (lines ~180-202) for other external APIs.

Add `vi` to the existing vitest import at the top of `apps/api/test/integration/payments-tier.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
```

Add to the same file (new `it` blocks, after the existing tests, before the closing `});` of the `describe` block):

```ts
  function mockRazorpayOrderCreate() {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.razorpay.com/v1/orders') {
        return new Response(JSON.stringify({ id: `order_mock_${Date.now()}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    });
  }

  it('stores the provided GSTIN on the payments row at order creation', async () => {
    mockRazorpayOrderCreate();
    const { token } = await registerUser('order-gstin@x.com');
    await seedPlan('gstin-plan');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { planId: 'gstin-plan', gstin: '27AAPFU0939F1ZV' },
    });
    expect(res.statusCode).toBe(200);

    const [payment] = await app.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.razorpayOrderId, res.json().orderId));
    expect(payment?.gstin).toBe('27AAPFU0939F1ZV');

    vi.restoreAllMocks();
  });

  it('rejects order creation with a malformed GSTIN', async () => {
    mockRazorpayOrderCreate();
    const { token } = await registerUser('order-badgstin@x.com');
    await seedPlan('badgstin-plan');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { planId: 'badgstin-plan', gstin: 'not-a-gstin' },
    });
    expect(res.statusCode).toBe(400);

    vi.restoreAllMocks();
  });
```

This test file's `beforeAll` calls `buildTestApp(c, { RAZORPAY_KEY_SECRET })` without `RAZORPAY_KEY_ID` — check that call and add `RAZORPAY_KEY_ID: 'test-razorpay-key-id'` alongside it, otherwise `POST /v1/payments/orders` 503s with `NOT_CONFIGURED` before ever reaching the (now-mocked) Razorpay call.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- payments-tier.test.ts`
Expected: FAIL — `payment.gstin` is `undefined` (the route doesn't read/store `gstin` yet), and the malformed-GSTIN case gets 200 instead of 400 (unknown field currently silently stripped by Zod).

- [x] **Step 3: Wire `gstin` into `POST /v1/payments/orders`**

In `apps/api/src/modules/payments/routes.ts`, add the import at the top:

```ts
import { Gstin } from '@tryme/types';
```

In the route's Zod `body` schema (~line 188-190):

```ts
      schema: {
        body: z.object({ planId: z.string().min(1), gstin: Gstin }),
      },
```

In the handler (~line 198), destructure and normalize:

```ts
      const { planId, gstin } = req.body as { planId: string; gstin?: string };
      const normalizedGstin = gstin?.trim().toUpperCase() || null;
```

In the `app.db.insert(schema.payments).values({...})` call (~line 215-224), add the field:

```ts
      await app.db.insert(schema.payments).values({
        userId: req.userId,
        planId: plan.slug,
        razorpayOrderId: rzpOrder.id,
        basePaise: plan.basePaise,
        gstPaise,
        totalPaise,
        credits: plan.credits,
        gstin: normalizedGstin,
        status: 'created',
      });
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- payments-tier.test.ts`
Expected: PASS (all cases, including the two new ones)

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/payments/routes.ts apps/api/test/integration/payments-tier.test.ts
git commit -m "feat(api): capture and validate GSTIN at order creation"
```

---

## Task 5: Admin-configurable seller GST details

**Files:**
- Modify: `packages/types/src/admin.ts`
- Modify: `apps/api/src/lib/resolution-config.ts`
- Modify: `apps/api/src/modules/admin/config.routes.ts`
- Test: `apps/api/test/resolution-config.test.ts` (extend, if it covers `GET /admin/config` defaults — check first; otherwise add a new focused test)

**Interfaces:**
- Produces: `SystemConfigBody.seller` (Zod, optional `{ gstin?, legalName?, address? }`), `DEFAULT_SELLER_CONFIG` constant, `GET /admin/config` response includes `seller` (defaulted), `PATCH /admin/config` accepts `seller`.

- [x] **Step 1: Add `seller` to `SystemConfigBody`**

In `packages/types/src/admin.ts`, add to the `SystemConfigBody` object (after `uploadLimits`, before the closing `});` at line ~174):

```ts
  // Seller details printed on every GST invoice (issueInvoiceIfNeeded,
  // apps/api/src/modules/payments/invoice.ts). All optional — invoices
  // render with blank fields until an admin fills these in.
  seller: z
    .object({
      gstin: z.string().max(15).optional(),
      legalName: z.string().max(200).optional(),
      address: z.string().max(500).optional(),
    })
    .optional(),
```

- [x] **Step 2: Add `DEFAULT_SELLER_CONFIG`**

In `apps/api/src/lib/resolution-config.ts`, add (near the other `DEFAULT_*` constants, e.g. after `DEFAULT_SHOPIFY_TRIAL_CONFIG`):

```ts
export const DEFAULT_SELLER_CONFIG: { gstin: string; legalName: string; address: string } = {
  gstin: '',
  legalName: '',
  address: '',
};
```

- [x] **Step 3: Wire defaults into `GET /admin/config` and pass-through in `PATCH`**

In `apps/api/src/modules/admin/config.routes.ts`, add the import:

```ts
import {
  DEFAULT_MAX_OUTPUT_PX,
  DEFAULT_PIXVERSE_CONFIG,
  DEFAULT_RESOLUTION_CONFIG,
  DEFAULT_SAREE_MANNEQUIN_DEV_CONFIG,
  DEFAULT_SELLER_CONFIG,
  DEFAULT_SHOPIFY_TRIAL_CONFIG,
  DEFAULT_TRYON_CONFIG,
} from '../../lib/resolution-config.js';
```

In the `GET /admin/config` handler (~line 42-61), add:

```ts
      cfg.uploadLimits = { ...DEFAULT_UPLOAD_LIMITS, ...cfg.uploadLimits };
      cfg.seller = { ...DEFAULT_SELLER_CONFIG, ...cfg.seller };
      return cfg;
```

`PATCH /admin/config` (~line 63-75) already merges the whole body shallowly (`{ ...cur, ...req.body }`), so passing `{ seller: {...} }` in a `PATCH` already works correctly as long as the caller always sends the full `seller` object (not a partial merge) — no route code change needed there, but note this for the frontend task (Task 12): always send all three seller fields together, not one at a time.

- [x] **Step 4: Manually verify**

With the API running against `pnpm docker:up` infra:

```bash
curl -X PATCH http://localhost:4000/admin/config \
  -H "Authorization: Bearer <a SUPER_ADMIN token>" -H "Content-Type: application/json" \
  -d '{"seller":{"gstin":"27AAPFU0939F1ZV","legalName":"Tryme Technologies Pvt Ltd","address":"123 Example St, Mumbai"}}'
curl http://localhost:4000/admin/config -H "Authorization: Bearer <token>"
```

Expected: the second call's response includes `"seller":{"gstin":"27AAPFU0939F1ZV",...}`.

- [x] **Step 5: Commit**

```bash
git add packages/types/src/admin.ts apps/api/src/lib/resolution-config.ts apps/api/src/modules/admin/config.routes.ts
git commit -m "feat(api): add admin-configurable seller GST details"
```

---

## Task 6: Invoice PDF renderer

**Files:**
- Modify: `apps/api/package.json` (add `pdfkit` + `@types/pdfkit`)
- Create: `apps/api/src/modules/payments/invoice-pdf.ts`
- Test: `apps/api/src/modules/payments/invoice-pdf.test.ts` (new)

**Interfaces:**
- Produces: `renderInvoicePdf(data: InvoiceData): Promise<Buffer>`, `financialYearFor(date: Date): string` (exported for reuse by Task 8's numbering logic), `InvoiceData` type.

- [x] **Step 1: Add the `pdfkit` dependency**

```bash
pnpm --filter @tryme/api add pdfkit
pnpm --filter @tryme/api add -D @types/pdfkit
```

- [x] **Step 2: Write the failing test**

Create `apps/api/src/modules/payments/invoice-pdf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { financialYearFor, renderInvoicePdf } from './invoice-pdf.js';

describe('financialYearFor', () => {
  it('returns the Apr-start year for a date in April or later', () => {
    expect(financialYearFor(new Date('2026-08-12T00:00:00Z'))).toBe('2026-27');
    expect(financialYearFor(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
  });

  it('returns the previous Apr-start year for a date in Jan-Mar', () => {
    expect(financialYearFor(new Date('2026-03-31T23:59:59Z'))).toBe('2025-26');
    expect(financialYearFor(new Date('2026-01-01T00:00:00Z'))).toBe('2025-26');
  });
});

describe('renderInvoicePdf', () => {
  it('produces a non-empty PDF buffer starting with the %PDF magic bytes', async () => {
    const buf = await renderInvoicePdf({
      invoiceNumber: 'INV-2026-27-000001',
      issuedAt: new Date('2026-08-12T00:00:00Z'),
      seller: { gstin: '27AAPFU0939F1ZV', legalName: 'Tryme Technologies Pvt Ltd', address: '123 Example St' },
      customer: { email: 'buyer@example.com', gstin: '29AAAAA0000A1Z5' },
      planName: 'Growth',
      credits: 5000,
      basePaise: 100000,
      gstPaise: 18000,
      totalPaise: 118000,
    });
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('produces a valid PDF when seller/customer GST fields are empty', async () => {
    const buf = await renderInvoicePdf({
      invoiceNumber: 'INV-2026-27-000002',
      issuedAt: new Date('2026-08-12T00:00:00Z'),
      seller: { gstin: '', legalName: '', address: '' },
      customer: { email: 'buyer2@example.com', gstin: null },
      planName: 'Starter',
      credits: 1000,
      basePaise: 20000,
      gstPaise: 3600,
      totalPaise: 23600,
    });
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
```

- [x] **Step 2b: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- invoice-pdf.test.ts`
Expected: FAIL — `./invoice-pdf.js` does not exist.

- [x] **Step 3: Implement `invoice-pdf.ts`**

Create `apps/api/src/modules/payments/invoice-pdf.ts`:

```ts
import PDFDocument from 'pdfkit';

export interface InvoiceData {
  invoiceNumber: string;
  issuedAt: Date;
  seller: { gstin: string; legalName: string; address: string };
  customer: { email: string; gstin: string | null };
  planName: string;
  credits: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
}

// Apr 1 - Mar 31 Indian GST financial year, e.g. "2026-27" for any date
// from 2026-04-01 through 2027-03-31.
export function financialYearFor(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1; // getUTCMonth() is 0-indexed; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function fmtRupees(paise: number): string {
  return `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

export function renderInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('TAX INVOICE', { align: 'center' });
    doc.moveDown();

    doc.fontSize(10);
    doc.text(`Invoice Number: ${data.invoiceNumber}`);
    doc.text(`Invoice Date: ${data.issuedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`);
    doc.moveDown();

    doc.fontSize(12).text('Seller', { underline: true });
    doc.fontSize(10);
    doc.text(data.seller.legalName || '—');
    doc.text(data.seller.address || '—');
    doc.text(`GSTIN: ${data.seller.gstin || '—'}`);
    doc.moveDown();

    doc.fontSize(12).text('Customer', { underline: true });
    doc.fontSize(10);
    doc.text(data.customer.email);
    doc.text(`GSTIN: ${data.customer.gstin || '—'}`);
    doc.moveDown();

    const tableTop = doc.y + 10;
    doc.fontSize(10);
    doc.text('Description', 50, tableTop);
    doc.text('Amount', 450, tableTop, { width: 100, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

    let y = tableTop + 25;
    doc.text(`${data.planName} — ${data.credits.toLocaleString('en-IN')} Credits`, 50, y);
    doc.text(fmtRupees(data.basePaise), 450, y, { width: 100, align: 'right' });
    y += 20;
    doc.text('GST (18%)', 50, y);
    doc.text(fmtRupees(data.gstPaise), 450, y, { width: 100, align: 'right' });
    y += 15;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 10;
    doc.fontSize(11).text('Total', 50, y);
    doc.text(fmtRupees(data.totalPaise), 450, y, { width: 100, align: 'right' });

    doc.end();
  });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- invoice-pdf.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/modules/payments/invoice-pdf.ts apps/api/src/modules/payments/invoice-pdf.test.ts
git commit -m "feat(api): add pdfkit-based GST invoice PDF renderer"
```

---

## Task 7: Storage key builder for invoices

**Files:**
- Modify: `packages/storage/src/keys.ts`

**Interfaces:**
- Produces: `keys.invoice(paymentId: string): string`

- [x] **Step 1: Add the key builder**

In `packages/storage/src/keys.ts`, add (near `supportAttachment`, at the end of the object):

```ts
  supportAttachment: (id: string, ext: string) => `support/${id}.${ext}`,
  invoice: (paymentId: string) => `invoices/${paymentId}.pdf`,
};
```

- [x] **Step 2: Rebuild the storage package**

```bash
pnpm --filter @tryme/storage build
```

Expected: builds without error.

- [x] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add invoice PDF key builder"
```

---

## Task 8: `issueInvoiceIfNeeded` helper

**Files:**
- Create: `apps/api/src/modules/payments/issue-invoice.ts`
- Test: `apps/api/test/integration/issue-invoice.test.ts` (new)

**Interfaces:**
- Consumes: `renderInvoicePdf`, `financialYearFor` (Task 6), `keys.invoice` (Task 7), `schema.invoices`, `schema.invoiceSequences`, `schema.payments` (Task 1), `DEFAULT_SELLER_CONFIG` (Task 5).
- Produces: `issueInvoiceIfNeeded(app: FastifyInstance, paymentId: string): Promise<{ invoiceNumber: string; pdfBuffer: Buffer } | null>` — returns `null` on any failure (never throws), returns the number + buffer on success (including when it's a no-op because an invoice already exists — re-renders and re-fetches nothing extra, just re-reads the existing row and re-downloads the stored PDF from R2 so the caller can still email it).

- [x] **Step 1: Write the failing test**

Create `apps/api/test/integration/issue-invoice.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueInvoiceIfNeeded } from '../../src/modules/payments/issue-invoice.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('issueInvoiceIfNeeded', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedPaidPayment(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash: 'x', tier: 'free', emailVerified: true })
      .returning();
    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: 'growth',
        razorpayOrderId: `order_${email}`,
        razorpayPaymentId: `pay_${email}`,
        basePaise: 100000,
        gstPaise: 18000,
        totalPaise: 118000,
        credits: 5000,
        gstin: '27AAPFU0939F1ZV',
        status: 'paid',
        paidAt: new Date(),
      })
      .returning();
    return payment;
  }

  it('issues a sequential invoice number and uploads a PDF to R2', async () => {
    const payment = await seedPaidPayment('issue-invoice-1@x.com');

    const result = await issueInvoiceIfNeeded(app, payment.id);
    expect(result).not.toBeNull();
    expect(result?.invoiceNumber).toMatch(/^INV-\d{4}-\d{2}-\d{6}$/);
    expect(result?.pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const [row] = await app.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, payment.id));
    expect(row).toBeDefined();
    expect(row.invoiceNumber).toBe(result?.invoiceNumber);

    const stored = await app.storage.getObject(row.r2Key);
    expect(stored.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('allocates sequential numbers across two different payments', async () => {
    const p1 = await seedPaidPayment('issue-invoice-seq-1@x.com');
    const p2 = await seedPaidPayment('issue-invoice-seq-2@x.com');

    const r1 = await issueInvoiceIfNeeded(app, p1.id);
    const r2 = await issueInvoiceIfNeeded(app, p2.id);

    const n1 = Number(r1?.invoiceNumber.split('-').pop());
    const n2 = Number(r2?.invoiceNumber.split('-').pop());
    expect(n2).toBe(n1 + 1);
  });

  it('is idempotent — calling twice for the same payment yields exactly one invoices row', async () => {
    const payment = await seedPaidPayment('issue-invoice-idempotent@x.com');

    const first = await issueInvoiceIfNeeded(app, payment.id);
    const second = await issueInvoiceIfNeeded(app, payment.id);

    expect(second?.invoiceNumber).toBe(first?.invoiceNumber);

    const rows = await app.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });

  it('returns null (never throws) for a payment that is not paid', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: 'issue-invoice-unpaid@x.com', passwordHash: 'x', tier: 'free' })
      .returning();
    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: 'growth',
        razorpayOrderId: 'order_unpaid',
        basePaise: 100000,
        gstPaise: 18000,
        totalPaise: 118000,
        credits: 5000,
        status: 'created',
      })
      .returning();

    const result = await issueInvoiceIfNeeded(app, payment.id);
    expect(result).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- issue-invoice.test.ts`
Expected: FAIL — `../../src/modules/payments/issue-invoice.js` does not exist.

- [x] **Step 3: Implement `issue-invoice.ts`**

Create `apps/api/src/modules/payments/issue-invoice.ts`:

```ts
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SELLER_CONFIG } from '../../lib/resolution-config.js';
import { financialYearFor, renderInvoicePdf } from './invoice-pdf.js';

const CONFIG_KEY = 'config:system';

async function readSellerConfig(
  app: FastifyInstance,
): Promise<{ gstin: string; legalName: string; address: string }> {
  const raw = await app.redis.get(CONFIG_KEY);
  const cfg = raw ? JSON.parse(raw) : {};
  return { ...DEFAULT_SELLER_CONFIG, ...cfg.seller };
}

async function allocateInvoiceNumber(
  app: FastifyInstance,
  financialYear: string,
): Promise<string> {
  // Single upsert statement: on first invoice of a financial year, inserts
  // nextNumber=2 and this call receives 2-1=1; on every subsequent call,
  // the ON CONFLICT branch atomically increments and returns the
  // pre-increment value — the row-level lock during the upsert is what
  // keeps this gap-free and race-safe under concurrent purchases.
  const [row] = await app.db
    .insert(schema.invoiceSequences)
    .values({ financialYear, nextNumber: 2 })
    .onConflictDoUpdate({
      target: schema.invoiceSequences.financialYear,
      set: { nextNumber: sql`${schema.invoiceSequences.nextNumber} + 1` },
    })
    .returning({ nextNumber: schema.invoiceSequences.nextNumber });
  const issuedNumber = (row?.nextNumber ?? 2) - 1;
  return `INV-${financialYear}-${String(issuedNumber).padStart(6, '0')}`;
}

/**
 * Non-fatal — never throws. Returns null on any failure (payment not
 * found/not paid, PDF render error, R2 upload error, DB error) so callers
 * can safely fire-and-forget this after a credit grant. Idempotent: a
 * second call for the same paymentId returns the already-issued invoice
 * (re-reads it from R2) instead of allocating a new number.
 */
export async function issueInvoiceIfNeeded(
  app: FastifyInstance,
  paymentId: string,
): Promise<{ invoiceNumber: string; pdfBuffer: Buffer } | null> {
  try {
    const [existing] = await app.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, paymentId));
    if (existing) {
      const pdfBuffer = await app.storage.getObject(existing.r2Key);
      return { invoiceNumber: existing.invoiceNumber, pdfBuffer };
    }

    const [payment] = await app.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));
    if (!payment || payment.status !== 'paid') return null;

    const [user] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, payment.userId));
    if (!user?.email) return null;

    const [plan] = await app.db
      .select({ name: schema.creditPlans.name })
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, payment.planId));

    const issuedAt = payment.paidAt ?? new Date();
    const financialYear = financialYearFor(issuedAt);
    const seller = await readSellerConfig(app);

    const invoiceNumber = await allocateInvoiceNumber(app, financialYear);
    const pdfBuffer = await renderInvoicePdf({
      invoiceNumber,
      issuedAt,
      seller,
      customer: { email: user.email, gstin: payment.gstin },
      planName: plan?.name ?? payment.planId,
      credits: payment.credits,
      basePaise: payment.basePaise,
      gstPaise: payment.gstPaise,
      totalPaise: payment.totalPaise,
    });

    const r2Key = keys.invoice(paymentId);
    await app.storage.putObject(r2Key, pdfBuffer, 'application/pdf');

    await app.db
      .insert(schema.invoices)
      .values({ paymentId, invoiceNumber, r2Key, issuedAt })
      .onConflictDoNothing({ target: schema.invoices.paymentId });

    return { invoiceNumber, pdfBuffer };
  } catch (err) {
    app.log.warn({ err, paymentId }, 'issueInvoiceIfNeeded failed — non-fatal');
    return null;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- issue-invoice.test.ts`
Expected: PASS (all 4 cases)

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/payments/issue-invoice.ts apps/api/test/integration/issue-invoice.test.ts
git commit -m "feat(api): add non-fatal, idempotent GST invoice issuance"
```

---

## Task 9: Wire invoice issuance into /verify + webhook, attach PDF to receipt email

**Files:**
- Modify: `apps/api/src/modules/payments/routes.ts`
- Modify: `apps/api/src/lib/mailer.ts`
- Test: `apps/api/test/integration/payments-tier.test.ts` (extend)

**Interfaces:**
- Consumes: `issueInvoiceIfNeeded` (Task 8).
- Produces: `sendPaymentReceiptEmail` gains an optional 5th param `invoice?: { invoiceNumber: string; pdfBuffer: Buffer }`, attached to the email when present.

- [x] **Step 1: Write the failing test**

Add to `apps/api/test/integration/payments-tier.test.ts`:

```ts
  it('issues an invoice as part of a successful /verify call', async () => {
    const { token, userId } = await registerUser('verify-invoice@x.com');
    const plan = await seedPlan('verify-invoice-plan');
    const orderId = 'order_verify_invoice_1';
    const payment = await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 1000,
    });

    const paymentId = 'pay_verify_invoice_1';
    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature(orderId, paymentId),
      },
    });

    // issueInvoiceIfNeeded is fire-and-forget (non-fatal, not awaited by the
    // route) — poll briefly for the row to appear instead of asserting
    // immediately after the response.
    let invoiceRow: { invoiceNumber: string } | undefined;
    for (let i = 0; i < 20 && !invoiceRow; i++) {
      const [row] = await app.db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.paymentId, payment.id));
      invoiceRow = row;
      if (!invoiceRow) await new Promise((r) => setTimeout(r, 100));
    }
    expect(invoiceRow?.invoiceNumber).toMatch(/^INV-\d{4}-\d{2}-\d{6}$/);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- payments-tier.test.ts`
Expected: FAIL (times out / no invoice row ever appears) — `/verify` doesn't call `issueInvoiceIfNeeded` yet.

- [x] **Step 3: Extend `sendPaymentReceiptEmail` to accept an optional attachment**

In `apps/api/src/lib/mailer.ts`, modify `sendPaymentReceiptEmail`'s signature and body:

```ts
export async function sendPaymentReceiptEmail(
  apiKey: string,
  from: string,
  to: string,
  receipt: {
    planName: string;
    credits: number;
    basePaise: number;
    gstPaise: number;
    totalPaise: number;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    paidAt: Date;
  },
  invoice?: { invoiceNumber: string; pdfBuffer: Buffer },
): Promise<void> {
  const totalRupees = (receipt.totalPaise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
  });
  await send(apiKey, {
    from,
    to,
    subject: `Payment confirmed — ${receipt.credits.toLocaleString('en-IN')} credits (₹${totalRupees})`,
    html: receiptHtml(receipt),
    ...(invoice
      ? {
          attachments: [
            {
              filename: `${invoice.invoiceNumber}.pdf`,
              content: invoice.pdfBuffer,
            },
          ],
        }
      : {}),
  });
}
```

- [x] **Step 4: Wire `issueInvoiceIfNeeded` into `/verify` and the webhook**

In `apps/api/src/modules/payments/routes.ts`, add the import:

```ts
import { issueInvoiceIfNeeded } from './issue-invoice.js';
```

Modify `maybeSendReceipt` (~line 34-74) to accept and pass through an optional invoice:

```ts
async function maybeSendReceipt(
  app: FastifyInstance,
  userId: string,
  payment: {
    planId: string;
    credits: number;
    basePaise: number;
    gstPaise: number;
    totalPaise: number;
    razorpayOrderId: string;
    razorpayPaymentId: string | null;
    paidAt: Date | null;
  },
  invoice?: { invoiceNumber: string; pdfBuffer: Buffer },
): Promise<void> {
  try {
    const [user] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!user) return;
    if (!user.email) return;

    const [plan] = await app.db
      .select({ name: schema.creditPlans.name })
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, payment.planId));

    await sendPaymentReceiptEmail(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      user.email,
      {
        planName: plan?.name ?? payment.planId,
        credits: payment.credits,
        basePaise: payment.basePaise,
        gstPaise: payment.gstPaise,
        totalPaise: payment.totalPaise,
        razorpayOrderId: payment.razorpayOrderId,
        razorpayPaymentId: payment.razorpayPaymentId ?? '',
        paidAt: payment.paidAt ?? new Date(),
      },
      invoice,
    );
  } catch (err) {
    app.log.warn({ err, userId }, 'receipt email failed — non-fatal');
  }
}
```

In the `/v1/payments/verify` handler, find the existing call:

```ts
      void maybeSendReceipt(app, req.userId, {
        ...payment,
        razorpayPaymentId,
        paidAt: new Date(),
      });
```

Replace it with:

```ts
      void (async () => {
        const invoice = await issueInvoiceIfNeeded(app, payment.id);
        await maybeSendReceipt(
          app,
          req.userId,
          { ...payment, razorpayPaymentId, paidAt: new Date() },
          invoice ?? undefined,
        );
      })();
```

Find the webhook's `payment.captured` branch (search for `maybeSendReceipt` — there should be a second call site inside the webhook handler around line 440-460) and apply the same replacement pattern, substituting whatever the local variable names are there (check the existing call's arguments to match exactly — the webhook handler builds its own `payment`-shaped object from its own query, not the same `payment` variable name as `/verify`).

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- payments-tier.test.ts`
Expected: PASS

- [x] **Step 6: Run the full payments + issue-invoice suites together to check for regressions**

Run: `pnpm --filter @tryme/api test -- payments`
Expected: all payment-related test files pass.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/payments/routes.ts apps/api/src/lib/mailer.ts apps/api/test/integration/payments-tier.test.ts
git commit -m "feat(api): issue and email GST invoices on successful payment"
```

---

## Task 10: Invoice download — extend history, new download route

**Files:**
- Modify: `apps/api/src/modules/payments/routes.ts`
- Test: `apps/api/test/integration/issue-invoice.test.ts` (extend) or a new focused test file — add to the existing one for locality.

**Interfaces:**
- Produces: `GET /v1/payments/history` rows gain `invoiceNumber: string | null` and `invoiceUrl: string | null`; new `GET /v1/payments/:id/invoice` (auth-gated, redirects to a presigned R2 GET URL).

- [x] **Step 1: Write the failing test**

`seedPaidPayment` (Task 8) inserts a user with `passwordHash: 'x'`, which isn't a real argon2 hash and can't log in — fine for Task 8's tests (they call `issueInvoiceIfNeeded` directly, no HTTP auth needed) but not for these, which need a real bearer token. Add a login-capable variant using the same `hashPassword` helper `apps/api/src/modules/auth/service.ts` already exports, avoiding the slower register+verify-email+login round trip.

Add to `apps/api/test/integration/issue-invoice.test.ts`:

Add the import at the top of `apps/api/test/integration/issue-invoice.test.ts`, alongside the existing ones:

```ts
import { hashPassword } from '../../src/modules/auth/service.js';
```

```ts
  async function seedLoginableUserWithPaidPayment(email: string) {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash, tier: 'free', emailVerified: true })
      .returning();
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '127.0.0.30',
      payload: { email, password: 'password123' },
    });
    const token = loginRes.json().accessToken as string;

    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: 'growth',
        razorpayOrderId: `order_${email}`,
        razorpayPaymentId: `pay_${email}`,
        basePaise: 100000,
        gstPaise: 18000,
        totalPaise: 118000,
        credits: 5000,
        gstin: '27AAPFU0939F1ZV',
        status: 'paid',
        paidAt: new Date(),
      })
      .returning();
    return { token, userId: user.id, payment };
  }

  it('GET /v1/payments/history includes invoiceNumber/invoiceUrl once issued', async () => {
    const { token, payment } = await seedLoginableUserWithPaidPayment('history-invoice@x.com');
    const issued = await issueInvoiceIfNeeded(app, payment.id);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments/history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().payments.find((p: { id: string }) => p.id === payment.id);
    expect(row.invoiceNumber).toBe(issued?.invoiceNumber);
    expect(typeof row.invoiceUrl).toBe('string');
  });

  it('GET /v1/payments/:id/invoice redirects to the invoice for its owner, 403s for others', async () => {
    const { token: ownerToken, payment } =
      await seedLoginableUserWithPaidPayment('invoice-owner@x.com');
    await issueInvoiceIfNeeded(app, payment.id);

    const { token: otherToken } = await seedLoginableUserWithPaidPayment('invoice-other@x.com');

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/v1/payments/${payment.id}/invoice`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerRes.statusCode).toBe(302);

    const otherRes = await app.inject({
      method: 'GET',
      url: `/v1/payments/${payment.id}/invoice`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherRes.statusCode).toBe(403);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- issue-invoice.test.ts`
Expected: FAIL — `invoiceNumber`/`invoiceUrl` are absent from `/v1/payments/history`, and `GET /v1/payments/:id/invoice` doesn't exist (404).

- [x] **Step 3: Extend `GET /v1/payments/history`**

In `apps/api/src/modules/payments/routes.ts`, modify the `GET /v1/payments/history` handler (~line 159-181):

```ts
  app.get('/v1/payments/history', { preHandler: app.requireUser }, async (req) => {
    const rows = await app.db
      .select({
        id: schema.payments.id,
        planId: schema.payments.planId,
        planName: schema.creditPlans.name,
        credits: schema.payments.credits,
        basePaise: schema.payments.basePaise,
        gstPaise: schema.payments.gstPaise,
        totalPaise: schema.payments.totalPaise,
        razorpayOrderId: schema.payments.razorpayOrderId,
        razorpayPaymentId: schema.payments.razorpayPaymentId,
        status: schema.payments.status,
        createdAt: schema.payments.createdAt,
        paidAt: schema.payments.paidAt,
        invoiceNumber: schema.invoices.invoiceNumber,
        invoiceR2Key: schema.invoices.r2Key,
      })
      .from(schema.payments)
      .leftJoin(schema.creditPlans, eq(schema.creditPlans.slug, schema.payments.planId))
      .leftJoin(schema.invoices, eq(schema.invoices.paymentId, schema.payments.id))
      .where(eq(schema.payments.userId, req.userId))
      .orderBy(desc(schema.payments.createdAt))
      .limit(100);

    const payments = await Promise.all(
      rows.map(async ({ invoiceR2Key, ...row }) => ({
        ...row,
        invoiceUrl: invoiceR2Key ? (await app.storage.presignGet(invoiceR2Key, 3600)).url : null,
      })),
    );
    return { payments };
  });
```

- [x] **Step 4: Add `GET /v1/payments/:id/invoice`**

Add a new route in the same file, after `GET /v1/payments/history`:

```ts
  app.get(
    '/v1/payments/:id/invoice',
    { preHandler: app.requireUser },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [payment] = await app.db
        .select({ id: schema.payments.id, userId: schema.payments.userId })
        .from(schema.payments)
        .where(eq(schema.payments.id, id));
      if (!payment) throw new AppError('NOT_FOUND', 404, 'payment not found');
      if (payment.userId !== req.userId) throw new AppError('FORBIDDEN', 403, 'forbidden');

      const [invoice] = await app.db
        .select({ r2Key: schema.invoices.r2Key })
        .from(schema.invoices)
        .where(eq(schema.invoices.paymentId, id));
      if (!invoice) throw new AppError('NOT_FOUND', 404, 'invoice not yet issued');

      const { url } = await app.storage.presignGet(invoice.r2Key, 3600);
      reply.redirect(url);
    },
  );
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- issue-invoice.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/payments/routes.ts apps/api/test/integration/issue-invoice.test.ts
git commit -m "feat(api): expose invoice download via payment history and a dedicated route"
```

---

## Task 11: Admin-web — seller GST settings UI

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `GET /admin/config` (now returns `seller`), `PATCH /admin/config` (now accepts `seller`) — from Task 5.

- [x] **Step 1: Add state**

In `apps/admin-web/src/pages/SettingsPage.tsx`, add new state near `maxOutputPx`/`maxBatchJobs` (~line 246-247):

```ts
  const [maxOutputPx, setMaxOutputPx] = useState(2048);
  const [maxBatchJobs, setMaxBatchJobs] = useState(200);
  const [sellerGstin, setSellerGstin] = useState('');
  const [sellerLegalName, setSellerLegalName] = useState('');
  const [sellerAddress, setSellerAddress] = useState('');
```

- [x] **Step 2: Load into state**

In the `useEffect` that fetches `/admin/config` (~line 292-350), extend the response type and the load logic:

```ts
    apiFetch<{
      maxOutputPx?: number;
      maxBatchJobs?: number;
      seller?: { gstin?: string; legalName?: string; address?: string };
      merchantCatalogDefaults?: Record<
        string,
        { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
      >;
      merchantCatalogAspectRatio?: string;
      uploadLimits?: Record<string, number>;
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.maxBatchJobs) setMaxBatchJobs(cfg.maxBatchJobs);
        if (cfg.seller) {
          setSellerGstin(cfg.seller.gstin ?? '');
          setSellerLegalName(cfg.seller.legalName ?? '');
          setSellerAddress(cfg.seller.address ?? '');
        }
```

(Keep the rest of that block — `merchantCatalogDefaults`, `uploadLimits`, etc. — unchanged.)

- [x] **Step 3: Include in save**

In `saveSysConfig` (~line 398-430), add `seller` to the `PATCH` body:

```ts
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          maxOutputPx,
          maxBatchJobs,
          seller: {
            gstin: sellerGstin.trim(),
            legalName: sellerLegalName.trim(),
            address: sellerAddress.trim(),
          },
          merchantCatalogDefaults: sanitizedMerchantCatalogDefaults,
          merchantCatalogAspectRatio,
          uploadLimits: {
            // ... unchanged, existing fields ...
```

- [x] **Step 4: Add the UI block**

In the JSX, after the "Max Batch Size" block (find its closing `</div>` — it ends right before the next `<div style={{ marginTop: 24, ...}}>` block, around line 850-860 based on the pattern seen at line 820-849), insert a new section following the exact same layout pattern as "Max Output Resolution":

```tsx
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    GST Invoice — Seller Details
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Printed as the seller block on every customer GST invoice. Leave blank fields
                    empty on the invoice until filled in.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
                    <input
                      className="input"
                      placeholder="Seller GSTIN"
                      value={sellerGstin}
                      disabled={sysSaving}
                      onChange={(e) => setSellerGstin(e.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="Legal business name"
                      value={sellerLegalName}
                      disabled={sysSaving}
                      onChange={(e) => setSellerLegalName(e.target.value)}
                    />
                    <textarea
                      className="input"
                      placeholder="Registered address"
                      value={sellerAddress}
                      disabled={sysSaving}
                      rows={3}
                      onChange={(e) => setSellerAddress(e.target.value)}
                    />
                  </div>
                </div>
```

- [x] **Step 5: Manually verify**

Run `pnpm --filter @tryme/admin dev`, open Settings, fill in the three fields, click Save, reload the page, confirm the values persist.

- [x] **Step 6: Typecheck and commit**

```bash
pnpm --filter @tryme/admin-web typecheck
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin-web): add seller GST details to Settings"
```

---

## Task 12: catalogues-web — profile GSTIN field

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/me` (now returns `gstin`), `PATCH /v1/me` (now accepts `gstin`) — from Task 3.
- Consumes: `GSTIN_REGEX` from `@tryme/types` (Task 2).

- [x] **Step 1: Extend `MeResponse` and add state**

In `apps/catalogues-web/src/app/(app)/settings/page.tsx`, add `gstin` to the `MeResponse` interface (~line 15-27):

```ts
interface MeResponse {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  companyName: string | null;
  gstin: string | null;
  tier: string;
  hasPassword: boolean;
  defaultResolution: string;
  defaultAspectRatio: string;
  defaultPlatform: string;
}
```

Add new state alongside `companyName`'s existing state (~line 270):

```ts
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [gstin, setGstin] = useState<string | null>(null);
  const [gstinError, setGstinError] = useState('');
```

Add the derived "value" pattern matching `companyNameVal` (~line 307):

```ts
  const companyNameVal = companyName ?? me?.companyName ?? '';
  const gstinVal = gstin ?? me?.gstin ?? '';
```

- [x] **Step 2: Validate and include in save**

Find the save handler that currently sends `companyName: companyNameVal.trim() || null` (~line 326) and add GSTIN validation immediately before that call, plus include `gstin` in the PATCH body:

```ts
    if (gstinVal.trim() && !GSTIN_REGEX.test(gstinVal.trim().toUpperCase())) {
      setGstinError('Invalid GSTIN format');
      return;
    }
    setGstinError('');
```

(Place this check alongside whatever other client-side validation already exists right before the `api.patch('/v1/me', {...})` call, and add `gstin: gstinVal.trim() || null,` into that call's body object, next to `companyName: companyNameVal.trim() || null,`.)

Add the import at the top of the file:

```ts
import { GSTIN_REGEX } from '@tryme/types';
```

- [x] **Step 3: Add the input field**

Find the `companyName` input (~line 557, in the same form section as other profile fields) and add a GSTIN input immediately after it, following the same styling pattern (read the surrounding JSX for the exact input wrapper markup and replicate it — label, input, and any error-text slot the form already uses for other fields):

```tsx
                <div>
                  <label style={{ fontSize: 13, fontWeight: 600, color: C.text }}>GSTIN (optional)</label>
                  <input
                    className="input"
                    placeholder="e.g. 27AAPFU0939F1ZV"
                    value={gstinVal}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                  />
                  {gstinError && (
                    <div style={{ fontSize: 12, color: C.pink, marginTop: 4 }}>{gstinError}</div>
                  )}
                </div>
```

- [x] **Step 4: Manually verify**

Run `pnpm --filter @tryme/web dev`, open Settings → Profile Details, enter a GSTIN, save, reload, confirm it persists; try an invalid one and confirm the inline error shows and the save is blocked.

- [x] **Step 5: Typecheck and commit**

```bash
pnpm --filter @tryme/catalogues-web typecheck
git add "apps/catalogues-web/src/app/(app)/settings/page.tsx"
git commit -m "feat(catalogues-web): let users set/edit their GSTIN in Settings"
```

---

## Task 13: New GSTIN + price-breakdown checkout confirmation modal

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/pricing/GstinConfirmModal.tsx`

**Interfaces:**
- Consumes: `CreditPlan` type from `./use-pricing-data` (existing), `GSTIN_REGEX` from `@tryme/types`, `C`/`grad` tokens.
- Produces: `<GstinConfirmModal>` component, props: `plan: CreditPlan`, `gstin: string`, `setGstin: (v: string) => void`, `displayBase/displayTax/displayTotal: (basePaise: number) => string`, `onClose: () => void`, `onPay: () => void`.

- [x] **Step 1: Implement the component**

Create `apps/catalogues-web/src/app/(app)/pricing/GstinConfirmModal.tsx`, modeled directly on the existing `CouponModal.tsx` (same backdrop/focus-trap/keyboard pattern — copy that file's `useEffect` focus-trap block verbatim) but with GSTIN input + price breakdown instead of a coupon code field:

```tsx
'use client';

import { GSTIN_REGEX } from '@tryme/types';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { C, grad } from '@/components/tokens';
import type { CreditPlan } from './use-pricing-data';

export function GstinConfirmModal({
  plan,
  gstin,
  setGstin,
  displayBase,
  displayTax,
  displayTotal,
  onClose,
  onPay,
}: {
  plan: CreditPlan;
  gstin: string;
  setGstin: (v: string) => void;
  displayBase: (basePaise: number) => string;
  displayTax: (basePaise: number) => string;
  displayTotal: (basePaise: number) => string;
  onClose: () => void;
  onPay: () => void;
}) {
  const [error, setError] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = el.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [onClose]);

  function handlePay() {
    const trimmed = gstin.trim().toUpperCase();
    if (trimmed && !GSTIN_REGEX.test(trimmed)) {
      setError('Invalid GSTIN format');
      return;
    }
    setError('');
    setGstin(trimmed);
    onPay();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismisses modal
    <div
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(420px, calc(100vw - 32px))',
          background: C.white,
          borderRadius: 16,
          padding: 24,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: C.mid,
          }}
        >
          <X size={20} />
        </button>

        <div
          style={{
            background: C.field,
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Have a GSTIN? <span style={{ fontWeight: 400, color: C.mid }}>(optional)</span>
          </div>
          <div style={{ fontSize: 12, color: C.mid, marginBottom: 10 }}>
            Add it to get a GST invoice you can claim as input tax credit. Leave blank and you'll
            still get a tax invoice for your records.
          </div>
          <input
            className="input"
            placeholder="GSTIN (e.g. 27AAPFU0939F1ZV)"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            style={{ width: '100%' }}
          />
          {error && <div style={{ fontSize: 12, color: C.pink, marginTop: 6 }}>{error}</div>}
        </div>

        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span style={{ color: C.mid }}>Subtotal</span>
            <span style={{ color: C.text }}>{displayBase(plan.basePaise)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span style={{ color: C.mid }}>GST @ 18%</span>
            <span style={{ color: C.text }}>{displayTax(plan.basePaise)}</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 15,
              fontWeight: 700,
              paddingTop: 8,
              borderTop: `1px solid ${C.border}`,
            }}
          >
            <span style={{ color: C.text }}>Total</span>
            <span style={{ color: C.text }}>{displayTotal(plan.basePaise)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handlePay}
          style={{
            width: '100%',
            padding: '14px 0',
            borderRadius: 12,
            border: 'none',
            background: grad,
            color: '#fff',
            fontWeight: 700,
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          Pay {displayTotal(plan.basePaise)}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: C.mid, marginTop: 8 }}>
          Secure payment via Razorpay
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/catalogues-web typecheck
```

Expected: no new errors (the component isn't imported/used anywhere yet, so this just checks the file compiles standalone).

- [x] **Step 3: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/pricing/GstinConfirmModal.tsx"
git commit -m "feat(catalogues-web): add GSTIN + price breakdown checkout confirmation modal"
```

---

## Task 14: Wire the confirmation modal into the purchase flow

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts`
- Modify: `apps/catalogues-web/src/app/(app)/pricing/layouts/Desktop.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/pricing/layouts/Mobile.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/pricing/layouts/Tablet.tsx`

**Interfaces:**
- Consumes: `GstinConfirmModal` (Task 13).
- Produces: hook gains `gstinModalPlan: CreditPlan | null`, `checkoutGstin: string`, `setCheckoutGstin`, `closeGstinModal`, `confirmGstinAndPay`; `buy` gains an optional second `gstin` param; every purchase now routes through the new modal before Razorpay opens.

- [x] **Step 1: Extend the `me` query type to include `gstin`**

In `use-pricing-data.ts` (~line 223-227), widen the type:

```ts
  const { data: me } = useQuery<{ tier: string; gstin: string | null }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
```

- [x] **Step 2: Add GSTIN modal state**

Near the existing coupon-modal state declarations, add:

```ts
  const [gstinModalPlan, setGstinModalPlan] = useState<CreditPlan | null>(null);
  const [checkoutGstin, setCheckoutGstin] = useState('');
```

- [x] **Step 3: Modify `buy` to accept and pass through `gstin`**

Change the signature:

```ts
  async function buy(plan: CreditPlan, gstin?: string) {
```

Inside `buy`, find the `api.post<{...}>('/v1/payments/orders', { planId: plan.slug })` call and change it to:

```ts
      const order = await api.post<{
        orderId: string;
        amount: number;
        currency: string;
        keyId: string;
        credits: number;
        label: string;
      }>('/v1/payments/orders', { planId: plan.slug, gstin: gstin || undefined });
```

- [x] **Step 4: Route `startBuy` and the coupon-modal continuation through the new modal instead of calling `buy` directly**

Replace the `startBuy` function:

```ts
  function startBuy(plan: CreditPlan) {
    if (buying) return;
    if (firstPurchaseBonusPercent === null && !hasPriorPurchase) {
      setCouponCode('');
      setCouponError('');
      setCouponApplied(false);
      setCouponBonusPercent(null);
      setCouponModalPlan(plan);
      return;
    }
    openGstinModal(plan);
  }

  function openGstinModal(plan: CreditPlan) {
    setCheckoutGstin(me?.gstin ?? '');
    setGstinModalPlan(plan);
  }

  function closeGstinModal() {
    if (buying) return;
    setGstinModalPlan(null);
  }

  function confirmGstinAndPay() {
    const plan = gstinModalPlan;
    setGstinModalPlan(null);
    if (plan) void buy(plan, checkoutGstin);
  }
```

Replace `continueFromCouponModal`:

```ts
  function continueFromCouponModal() {
    const plan = couponModalPlan;
    setCouponModalPlan(null);
    if (plan) openGstinModal(plan);
  }
```

- [x] **Step 5: Return the new state/functions from the hook**

In the `return {...}` block at the end of the file, add:

```ts
    gstinModalPlan,
    checkoutGstin,
    setCheckoutGstin,
    closeGstinModal,
    confirmGstinAndPay,
```

- [x] **Step 6: Render the modal in all three layouts**

In `Desktop.tsx`, `Mobile.tsx`, and `Tablet.tsx`: add the import

```ts
import { GstinConfirmModal } from '../GstinConfirmModal';
```

Destructure the new fields from the hook's return value alongside the existing `couponModalPlan` etc. (same destructuring block each file already has).

Render it next to the existing `{couponModalPlan && <CouponModal ... />}` block:

```tsx
      {gstinModalPlan && (
        <GstinConfirmModal
          plan={gstinModalPlan}
          gstin={checkoutGstin}
          setGstin={setCheckoutGstin}
          displayBase={displayBase}
          displayTax={displayTax}
          displayTotal={displayTotal}
          onClose={closeGstinModal}
          onPay={confirmGstinAndPay}
        />
      )}
```

- [x] **Step 7: Manually verify end-to-end**

Run `pnpm --filter @tryme/web dev` (with `pnpm docker:up` running and Razorpay test keys configured in `.env`), go to `/pricing`, click "Buy" on a plan:
- As a first-time non-attributed buyer: confirm the coupon modal appears first, then closing/continuing it shows the new GSTIN modal, then "Pay" opens the Razorpay widget.
- As a repeat buyer: confirm the GSTIN modal appears immediately on "Buy" click, pre-filled with any profile GSTIN, and "Pay" opens Razorpay.
- Enter a malformed GSTIN and confirm the inline error blocks proceeding.

- [x] **Step 8: Typecheck and commit**

```bash
pnpm --filter @tryme/catalogues-web typecheck
git add "apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts" \
  "apps/catalogues-web/src/app/(app)/pricing/layouts/Desktop.tsx" \
  "apps/catalogues-web/src/app/(app)/pricing/layouts/Mobile.tsx" \
  "apps/catalogues-web/src/app/(app)/pricing/layouts/Tablet.tsx"
git commit -m "feat(catalogues-web): show GSTIN/breakdown confirmation before every Razorpay checkout"
```

---

## Task 15: Payment history — Download Invoice link

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/payments/history` (now returns `invoiceNumber`/`invoiceUrl` per row) — Task 10.

- [x] **Step 1: Extend `PaymentRow` and the grid layout**

In `apps/catalogues-web/src/app/(app)/settings/page.tsx`, extend the `PaymentRow` interface (~line 32-44):

```ts
interface PaymentRow {
  id: string;
  planId: string;
  planName: string | null;
  credits: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  status: string;
  createdAt: string;
  paidAt: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
}
```

Change the two `gridTemplateColumns` occurrences in the Invoices tab (header at ~line 988, row at ~line 1025) from 6 to 7 columns, adding a slot for the new column:

```ts
                  gridTemplateColumns: '1.4fr 1.2fr 0.8fr 1fr 1fr 0.7fr 0.9fr',
```

Add `'Invoice'` to the header labels array (~line 994):

```ts
                  {['Date', 'Plan', 'Credits', 'Amount (incl. GST)', 'Payment ID', 'Status', 'Invoice'].map(
```

- [x] **Step 2: Add the download link in each row**

After the closing `</span>` of the status badge block (~line 1087, right before the row's closing `</div>` at line 1088), add:

```tsx
                      <span>
                        {p.invoiceUrl ? (
                          <a
                            href={p.invoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ fontSize: 12, fontWeight: 600, color: C.pink, textDecoration: 'none' }}
                          >
                            Download
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, color: C.light }}>—</span>
                        )}
                      </span>
```

- [x] **Step 3: Manually verify**

Run `pnpm --filter @tryme/web dev`, make a test purchase end-to-end, go to Settings → Invoices, confirm a "Download" link appears (may take a moment since issuance is fire-and-forget — refresh if it shows "—" immediately after purchase) and that clicking it downloads a valid PDF.

- [x] **Step 4: Typecheck and commit**

```bash
pnpm --filter @tryme/catalogues-web typecheck
git add "apps/catalogues-web/src/app/(app)/settings/page.tsx"
git commit -m "feat(catalogues-web): add invoice download link to payment history"
```

---

## Task 16: Full regression pass, docs, push, PR into dev

**Files:**
- Modify: `docs/progress.md`

- [x] **Step 1: Run the full API + dispatcher + types test suites**

```bash
pnpm --filter @tryme/types test
pnpm --filter @tryme/api test
```

Expected: all pass. If any pre-existing unrelated failures surface (check against a clean `dev` checkout first, same verification approach used for the flat-saree fix), note them but don't let them block this feature's own tests passing.

- [x] **Step 2: Full typecheck**

```bash
pnpm typecheck
```

Expected: no errors in any touched package (`@tryme/db`, `@tryme/types`, `@tryme/storage`, `@tryme/api`, `@tryme/catalogues-web`, `@tryme/admin-web`).

- [x] **Step 3: Update `docs/progress.md`**

Add a new dated entry at the top of the log (follow the existing entries' format exactly) summarizing: GSTIN capture (profile + per-purchase), sequential GST invoice generation (PDF via `pdfkit`, stored in R2), invoice delivery (download in payment history + email attachment), admin-configurable seller details. Note the spec at `docs/superpowers/specs/2026-08-12-gst-invoice-for-credit-purchases-design.md`.

- [x] **Step 4: Commit docs**

```bash
git add docs/progress.md
git commit -m "docs: log GST invoice feature completion"
```

- [x] **Step 5: Push and open the PR into `dev`**

```bash
git push -u origin feat/gst-invoice-credit-purchases
```

Open the PR at `https://github.com/adeshboudhnicedigitals/tryme/compare/dev...feat/gst-invoice-credit-purchases?expand=1` — **confirm the base branch is `dev`**, not `main` (this tripped up the flat-saree PR earlier in this same session). Title: `feat: GST invoice for credit purchases`. Body should summarize the feature and link the spec doc.

- [ ] **Step 6: After the `dev` PR merges — cherry-pick onto `main`**

Per the spec's Rollout section, once the PR above is merged into `dev`, cherry-pick the same commits onto a fresh `main`-based branch and PR directly into `main`, mirroring the exact process already used for the flat-saree prompt-override fix earlier in this session:

```bash
git fetch origin
git checkout -b feat/gst-invoice-credit-purchases-main origin/main
git log origin/dev --oneline | grep -B1 "GST invoice"   # find the commit range just merged
git cherry-pick <first-commit-sha>^..<last-commit-sha>   # or cherry-pick the squash-merge commit if the dev PR was squash-merged
```

Resolve any conflicts (unlikely — this is new code, not modifying anything else changed on `main` recently), rebuild affected packages (`pnpm --filter @tryme/db build`, etc., same as the flat-saree case needed), re-run the full test suite against `main`'s codebase, then push and open a `main`-based PR the same way.

---

## Self-Review Notes

**Spec coverage:** Every section of `docs/superpowers/specs/2026-08-12-gst-invoice-for-credit-purchases-design.md` maps to a task — data model (Task 1), GSTIN validation (Task 2), profile GSTIN (Task 3), order-creation GSTIN (Task 4), admin seller config (Task 5), PDF rendering (Task 6), storage key (Task 7), issuance helper (Task 8), verify/webhook wiring + email (Task 9), download routes (Task 10), admin UI (Task 11), profile UI (Task 12-13), checkout flow (Task 14), payment history UI (Task 15), rollout (Task 16).

**Placeholder scan fixes applied during self-review:** an earlier draft of Task 4 Step 1 left a "check whether this needs a Razorpay stub" note instead of code — resolved by confirming (via repo search) that no existing test calls `POST /v1/payments/orders` at all, then writing a concrete `vi.spyOn(global, 'fetch')` mock following the exact pattern already used in `google-oauth.test.ts`. Similarly, an earlier draft of Task 10 Step 1 left a "fix the login setup" note — resolved by using the `hashPassword` export from `apps/api/src/modules/auth/service.ts` to seed a real login-capable user directly, rather than the slower register+verify-email+login round trip. Both tasks now contain complete, runnable test code with no deferred decisions.

**Type consistency check:** `issueInvoiceIfNeeded`'s return type (`{ invoiceNumber: string; pdfBuffer: Buffer } | null`, Task 8) matches its usage in Task 9 (`const invoice = await issueInvoiceIfNeeded(...)`, passed as `invoice ?? undefined` into the now-5-arg `maybeSendReceipt`) and in Task 10's tests (`issued?.invoiceNumber`). `sendPaymentReceiptEmail`'s new optional 5th param name (`invoice`) matches what `maybeSendReceipt` passes through in Task 9.
