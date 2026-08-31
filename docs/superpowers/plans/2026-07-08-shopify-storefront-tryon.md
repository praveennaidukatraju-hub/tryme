# Shopify Storefront Try-On Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a "Try It On" button + upload modal on the Shopify storefront product page, built as a theme app extension calling the already-verified widget job API.

**Architecture:** Extend `apps/api`'s CORS handling to trust origins listed in `widgetClients.allowedOrigins` (currently hardcoded to one static origin — blocks this feature entirely). Write each store's `widgetKey` to a Shopify shop metafield at install so the storefront needs no manual config. Add a `resultUrl` field to the existing job-status endpoint. Everything else is a new Shopify CLI theme app extension (Liquid + vanilla JS) with no server-side code of its own.

**Tech Stack:** Fastify 5, Drizzle ORM, `@fastify/cors` 10.1.0, Vitest (for the 3 backend tasks); Shopify CLI + Liquid + vanilla JS (for the extension, manually tested — no unit-test harness applies to it).

## Global Constraints

- **CORS fix must not change existing behavior for the app's own frontend** — requests with `Origin` matching `env.CORS_ORIGIN` continue to work exactly as before.
- **Widget-key metafield write must never fail the install** — log and continue on any error, same tolerance pattern as the existing `shopifyRegisterWebhooks?.()` optional-chaining call in `auth.routes.ts`.
- **`resultUrl` only appears when `resultKey` is present** (i.e. only for completed jobs) — do not compute a URL from a null key.
- **Shoppers never see internal error codes or messages** — the widget JS shows one generic failure string for every backend error.
- **ESM only** (`.js` import specifiers), pnpm workspaces, pino via `@tryme/logger`, ASCII quotes, no `console.log` in committed code.
- **Theme extension scope:** button + modal + upload + poll + result only. No merchant-configurable settings, no embedded admin, no billing UI — those are separate, already-deferred plans.

---

## File Structure

**Create:**
- `apps/api/test/shopify-cors.test.ts` — CORS origin-function tests
- `apps/api/src/modules/shopify/metafields.ts` — `writeWidgetKeyMetafield()`, injectable-fetch pattern matching `products.sync.ts`
- `apps/api/test/shopify-metafields.test.ts` — metafield-write tests
- `apps/shopify-extension/shopify.extension.toml`
- `apps/shopify-extension/blocks/tryon-block.liquid`
- `apps/shopify-extension/assets/tryon-widget.js`
- `apps/shopify-extension/assets/tryon-widget.css`
- `apps/shopify-extension/locales/en.default.json`

**Modify:**
- `apps/api/src/server.ts` — CORS `origin` option becomes an async function
- `apps/api/src/modules/widget/routes.ts` — `GET /v1/widget/jobs/:id` gains `resultUrl`
- `apps/api/test/*jobs*` (existing widget job status test, if one asserts the exact response shape — check before editing)
- `apps/api/src/modules/shopify/auth.routes.ts` — call `writeWidgetKeyMetafield` after install/reactivate

---

## Task 1: Dynamic CORS by widget origin

**Files:**
- Modify: `apps/api/src/server.ts:74`
- Test: `apps/api/test/shopify-cors.test.ts`

**Interfaces:**
- Consumes: `schema.widgetClients.allowedOrigins` (existing `text[]` column), `env.CORS_ORIGIN` (existing).
- Produces: nothing new exported — this is a behavior change to the existing CORS plugin registration, consumed implicitly by every route (including the widget/Shopify routes the extension will call).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-cors.test.ts`:

```ts
import { schema } from '@tryme/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, type Containers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.db.insert(schema.widgetClients).values({
    companyName: 'CORS Test Co',
    contactName: 'Test',
    email: `cors-test-${randomUUID()}@example.com`,
    phone: '1',
    websiteUrl: 'https://allowed.example.com',
    companySize: 'unknown',
    purpose: 'test',
    businessAddress: 'n/a',
    passwordHash: '',
    isActive: true,
    allowedOrigins: ['https://allowed.example.com'],
  });
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('dynamic CORS', () => {
  it('reflects the static app origin (existing behavior unchanged)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('reflects an origin listed in some widgetClients.allowedOrigins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://allowed.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example.com');
  });

  it('does not allow an origin nobody has registered', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://not-registered.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-cors`
Expected: FAIL — the first two assertions may pass by coincidence (static origin) but the third fails because the current static `origin: env.CORS_ORIGIN` config either allows everything the wrong way or the second test (arbitrary widget origin) fails since nothing checks `allowedOrigins` yet. Confirm the second test's failure specifically: `access-control-allow-origin` will be `undefined` for `https://allowed.example.com` since only `http://localhost:3000` is currently ever reflected.

- [ ] **Step 3: Implement the dynamic origin function**

In `apps/api/src/server.ts`, replace line 74:

```ts
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
```

with:

```ts
  await app.register(cors, {
    origin: async (origin) => {
      if (!origin) return false;
      if (origin === env.CORS_ORIGIN) return true;
      const [row] = await app.db
        .select({ id: schema.widgetClients.id })
        .from(schema.widgetClients)
        .where(sql`${origin} = ANY(${schema.widgetClients.allowedOrigins})`)
        .limit(1);
      return !!row;
    },
    credentials: true,
  });
```

This requires two new imports at the top of `apps/api/src/server.ts` — add them alongside the existing `@tryme/db` usage (check whether `schema`/`sql` are already imported elsewhere in this file; if not, add):

```ts
import { schema } from '@tryme/db';
import { sql } from 'drizzle-orm';
```

**Important ordering note:** this origin function closes over `app`, and calls `app.db` at request time (inside the async function), not at registration time — this is safe even though `cors` registers (line 74) before `dbPlugin` (line 90), because the closure only evaluates `app.db` when an actual HTTP request arrives, which is always after the full plugin chain has finished loading and the server is listening. Do not move the `cors` registration below `dbPlugin` — that would be an unrelated, unnecessary reordering.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-cors`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full API suite to confirm no regression**

Run: `pnpm --filter @tryme/api test`
Expected: all pre-existing tests still pass (this change only affects the CORS preflight/response header, no route logic touched).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/server.ts apps/api/test/shopify-cors.test.ts
git commit -m "feat(api): dynamic CORS origin check against widgetClients.allowedOrigins"
```

---

## Task 2: `resultUrl` on `GET /v1/widget/jobs/:id`

**Files:**
- Modify: `apps/api/src/modules/widget/routes.ts:300-324`
- Test: check for an existing test file covering this route first (search `apps/api/test/` for `widget` — if one exists, extend it; if not, create `apps/api/test/widget-job-status.test.ts`)

**Interfaces:**
- Consumes: `app.storage.publicUrl(key: string): string` (existing, `packages/storage/src/index.ts:18`).
- Produces: `GET /v1/widget/jobs/:id` response gains `resultUrl: string | null` alongside the existing `{ id, status, resultKey, errorCode, createdAt, completedAt }` shape.

- [ ] **Step 1: Check for an existing test on this route**

Run: `grep -rn "widget/jobs/:id\|GET.*widget.*jobs" apps/api/test/`

If a test file already asserts the exact response shape of `GET /v1/widget/jobs/:id`, extend it with the new assertion in Step 2 below instead of creating a new file — do not create a duplicate test file for the same route.

- [ ] **Step 2: Write the failing test**

If no existing file covers this route, create `apps/api/test/widget-job-status.test.ts`:

```ts
import { schema } from '@tryme/db';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, type Containers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;
let widgetKey: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  const [wc] = await app.db
    .insert(schema.widgetClients)
    .values({
      companyName: 'Result URL Test',
      contactName: 'Test',
      email: `result-url-${randomUUID()}@example.com`,
      phone: '1',
      websiteUrl: 'https://example.com',
      companySize: 'unknown',
      purpose: 'test',
      businessAddress: 'n/a',
      passwordHash: '',
      isActive: true,
    })
    .returning();
  widgetKey = wc.widgetKey;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/widget/jobs/:id resultUrl', () => {
  it('includes resultUrl when the job has a result', async () => {
    const [wc] = await app.db
      .select()
      .from(schema.widgetClients)
      .where(eq(schema.widgetClients.widgetKey, widgetKey));
    const jobId = randomUUID();
    await app.db.insert(schema.jobs).values({
      id: jobId,
      userId: null,
      widgetClientId: wc.id,
      status: 'COMPLETED',
      creditsCharged: 10,
    } as Parameters<typeof app.db.insert<typeof schema.jobs>>[0] extends never ? never : any);
    await app.db.insert(schema.jobOutputs).values({
      jobId,
      resultKey: 'outputs/test-job/result.png',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/widget/jobs/${jobId}`,
      headers: { 'x-widget-key': widgetKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resultUrl).toBe(app.storage.publicUrl('outputs/test-job/result.png'));
  });

  it('has a null resultUrl when the job has no result yet', async () => {
    const [wc] = await app.db
      .select()
      .from(schema.widgetClients)
      .where(eq(schema.widgetClients.widgetKey, widgetKey));
    const jobId = randomUUID();
    await app.db.insert(schema.jobs).values({
      id: jobId,
      userId: null,
      widgetClientId: wc.id,
      status: 'QUEUED',
      creditsCharged: 10,
    } as Parameters<typeof app.db.insert<typeof schema.jobs>>[0] extends never ? never : any);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/widget/jobs/${jobId}`,
      headers: { 'x-widget-key': widgetKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resultUrl).toBeNull();
  });
});
```

> **Note for implementer:** the `as Parameters<...>` casts above are a placeholder for whatever the established `biome-ignore lint/suspicious/noExplicitAny` + `as any` pattern used elsewhere in this codebase for inserting into `schema.jobs` looks like (see `apps/api/src/modules/widget/routes.ts:257` for the exact idiom) — copy that idiom exactly rather than the awkward conditional type above; this plan's test scaffolding should not introduce a new casting style.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- widget-job-status` (or your extended existing file's name)
Expected: FAIL — `resultUrl` is `undefined`, not present on the response at all.

- [ ] **Step 4: Implement the change**

In `apps/api/src/modules/widget/routes.ts`, modify the `GET /v1/widget/jobs/:id` handler (currently lines 300-324):

```ts
  app.get('/v1/widget/jobs/:id', { preHandler: app.requireWidgetClient }, async (req, reply) => {
    const clientId = req.widgetClientId as string;
    const { id } = req.params as { id: string };

    const [job] = await app.db
      .select({
        id: schema.jobs.id,
        status: schema.jobs.status,
        widgetClientId: schema.jobs.widgetClientId,
        resultKey: schema.jobOutputs.resultKey,
        errorCode: schema.jobs.errorCode,
        createdAt: schema.jobs.createdAt,
        completedAt: schema.jobs.completedAt,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobOutputs, eq(schema.jobs.id, schema.jobOutputs.jobId))
      .where(eq(schema.jobs.id, id))
      .limit(1);

    if (!job || job.widgetClientId !== clientId) {
      throw new AppError('NOT_FOUND', 404, 'Job not found');
    }

    return reply.send({
      ...job,
      resultUrl: job.resultKey ? app.storage.publicUrl(job.resultKey) : null,
    });
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- widget-job-status`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS, no regressions (this is an additive field on an existing response object — any test asserting exact response equality rather than a subset would need updating; check for that during this run).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/widget/routes.ts apps/api/test/widget-job-status.test.ts
git commit -m "feat(api): add resultUrl to GET /v1/widget/jobs/:id"
```

---

## Task 3: Write `widget_key` shop metafield at install

**Files:**
- Create: `apps/api/src/modules/shopify/metafields.ts`
- Create: `apps/api/test/shopify-metafields.test.ts`
- Modify: `apps/api/src/modules/shopify/auth.routes.ts` (callback handler, after `upsertShopifyStore` succeeds)

**Interfaces:**
- Consumes: `SHOPIFY_API_VERSION` (existing, `apps/api/src/modules/shopify/service.ts`).
- Produces: `writeWidgetKeyMetafield(shop: string, accessToken: string, widgetKey: string, log: Logger, fetchFn?: typeof fetch): Promise<void>` — never throws; logs and swallows any failure (matches the tolerance of the existing `shopifyRegisterWebhooks?.()` call).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-metafields.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@tryme/logger';
import { writeWidgetKeyMetafield } from '../src/modules/shopify/metafields.js';

const log = createLogger('test');

describe('writeWidgetKeyMetafield', () => {
  it('POSTs the widget key as a shop metafield', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return { ok: true, status: 201 } as Response;
    });

    await writeWidgetKeyMetafield('shop.myshopify.com', 'shpat_token', 'wk-123', log, fakeFetch as unknown as typeof fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/admin/api/');
    expect(calls[0].url).toContain('/metafields.json');
    expect(calls[0].body).toEqual({
      metafield: {
        namespace: 'tryme',
        key: 'widget_key',
        value: 'wk-123',
        type: 'single_line_text_field',
      },
    });
  });

  it('does not throw when the request fails', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(
      writeWidgetKeyMetafield('shop.myshopify.com', 'shpat_token', 'wk-123', log, fakeFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it('does not throw when fetch itself rejects', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      writeWidgetKeyMetafield('shop.myshopify.com', 'shpat_token', 'wk-123', log, fakeFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-metafields`
Expected: FAIL — module `../src/modules/shopify/metafields.js` does not exist.

- [ ] **Step 3: Implement the function**

Create `apps/api/src/modules/shopify/metafields.ts`:

```ts
import type { Logger } from '@tryme/logger';
import { SHOPIFY_API_VERSION } from './service.js';

export async function writeWidgetKeyMetafield(
  shop: string,
  accessToken: string,
  widgetKey: string,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    const res = await fetchFn(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/metafields.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metafield: {
          namespace: 'tryme',
          key: 'widget_key',
          value: widgetKey,
          type: 'single_line_text_field',
        },
      }),
    });
    if (!res.ok) {
      log.error({ shop, status: res.status }, 'failed to write widget_key metafield');
    }
  } catch (err) {
    log.error({ err, shop }, 'failed to write widget_key metafield');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-metafields`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into the OAuth callback**

Read `apps/api/src/modules/shopify/auth.routes.ts` first to find the exact current line where `upsertShopifyStore` is called and `app.shopifyRegisterWebhooks?.()` is called right after (around line 170-172, per this session's earlier work) — insert the metafield write in the same place, after the store upsert succeeds:

```ts
    const store = await upsertShopifyStore(app, details, access_token, scope);
    await writeWidgetKeyMetafield(q.shop, access_token, store.widgetClientId /* WRONG — see note */, req.log);
```

**Stop — do not use `store.widgetClientId` for the metafield value.** The metafield must hold `widgetClients.widgetKey` (the UUID used as the `x-widget-key` header value), not `widgetClientId` (the primary key, a different UUID). `upsertShopifyStore`'s return value is the `shopifyStores` row, which does not include the `widgetClients.widgetKey` column. Before wiring this call, look up the widget client's `widgetKey` by `store.widgetClientId`:

```ts
    const store = await upsertShopifyStore(app, details, access_token, scope);
    const [wc] = await app.db
      .select({ widgetKey: schema.widgetClients.widgetKey })
      .from(schema.widgetClients)
      .where(eq(schema.widgetClients.id, store.widgetClientId))
      .limit(1);
    if (wc) await writeWidgetKeyMetafield(q.shop, access_token, wc.widgetKey, req.log);
    await app.shopifyRegisterWebhooks?.(q.shop, access_token);
```

Add the import at the top of `auth.routes.ts`:

```ts
import { writeWidgetKeyMetafield } from './metafields.js';
```

(`schema` and `eq` are already imported in this file per Task 6's original implementation — confirm before adding a duplicate import.)

- [ ] **Step 6: Run the OAuth test suite to confirm no regression**

Run: `pnpm --filter @tryme/api test -- shopify-oauth`
Expected: PASS (2 tests, unchanged — these tests call `upsertShopifyStore` directly and never hit the HTTP callback route, so they don't exercise this new call; this is a known pre-existing gap in test coverage for the full callback route, not introduced by this task).

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shopify/metafields.ts apps/api/test/shopify-metafields.test.ts apps/api/src/modules/shopify/auth.routes.ts
git commit -m "feat(api): write widget_key shop metafield on shopify install"
```

---

## Task 4: Theme app extension — scaffolding + Liquid block + JS widget

**Files:**
- Create: `apps/shopify-extension/shopify.extension.toml`
- Create: `apps/shopify-extension/blocks/tryon-block.liquid`
- Create: `apps/shopify-extension/assets/tryon-widget.js`
- Create: `apps/shopify-extension/assets/tryon-widget.css`
- Create: `apps/shopify-extension/locales/en.default.json`

**Interfaces:**
- Consumes: `POST /v1/widget/presign`, `POST /v1/widget/jobs`, `GET /v1/widget/jobs/:id` (all existing, the last one now returning `resultUrl` per Task 2). All three require an `x-widget-key` header — this extension reads that value from `shop.metafields.tryme.widget_key` (written by Task 3) at Liquid render time.
- Produces: nothing consumed by other tasks — this is the leaf/terminal task of this plan.

**No TDD here** — this is Liquid + browser JS with no server-side logic and no Vitest harness that applies to it. Verification is manual against the real dev store this session already installed the app on.

- [ ] **Step 1: Scaffold the extension via Shopify CLI**

From the repo root:

```bash
cd apps
shopify app generate extension --type=theme_app_extension --name=shopify-extension
```

Follow the CLI prompts, selecting the Partner app created earlier this session (client ID starting `771a0258...`, per this session's `.env`). This creates the `apps/shopify-extension/` directory with the standard skeleton (`shopify.extension.toml`, empty `blocks/`, `assets/`, `snippets/`, `locales/`). Confirm the generated `shopify.extension.toml` has `type = "theme"` — if the CLI generated something else, stop and report NEEDS_CONTEXT (the CLI's exact prompts/output may differ from what's documented; don't guess past a mismatch).

- [ ] **Step 2: Write the Liquid block**

Create (or replace the CLI-generated stub at) `apps/shopify-extension/blocks/tryon-block.liquid`:

```liquid
{% comment %}
  Renders a "Try It On" button + upload modal for the current product.
  Silently renders nothing if the store's widget_key metafield is missing
  (install incomplete, or metafield write failed) — a missing/broken
  button is safer on a live storefront than one that always errors.
{% endcomment %}

{%- assign widget_key = shop.metafields.tryme.widget_key -%}
{%- if widget_key != blank -%}
  <div
    class="tryme-tryon"
    data-widget-key="{{ widget_key }}"
    data-product-id="{{ product.id }}"
    data-api-base="{{ block.settings.api_base | default: 'https://api.tryme.com' }}"
  >
    <button type="button" class="tryme-tryon__button">
      {{ 'tryon.button_label' | t }}
    </button>

    <div class="tryme-tryon__modal" hidden>
      <div class="tryme-tryon__modal-content">
        <button type="button" class="tryme-tryon__close" aria-label="Close">&times;</button>

        <div class="tryme-tryon__step tryme-tryon__step--upload">
          <p>{{ 'tryon.upload_prompt' | t }}</p>
          <input type="file" accept="image/*" class="tryme-tryon__file-input" />
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--progress" hidden>
          <p>{{ 'tryon.generating' | t }}</p>
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--pending" hidden>
          <p>{{ 'tryon.pending' | t }}</p>
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--result" hidden>
          <img class="tryme-tryon__result-image" alt="{{ 'tryon.result_alt' | t }}" />
          <button type="button" class="tryme-tryon__retry">
            {{ 'tryon.try_another' | t }}
          </button>
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--error" hidden>
          <p>{{ 'tryon.error' | t }}</p>
          <button type="button" class="tryme-tryon__retry">
            {{ 'tryon.try_again' | t }}
          </button>
        </div>
      </div>
    </div>
  </div>

  {{ 'tryon-widget.css' | asset_url | stylesheet_tag }}
  <script src="{{ 'tryon-widget.js' | asset_url }}" defer></script>
{%- endif -%}

{% schema %}
{
  "name": "Try It On",
  "target": "section",
  "settings": [
    {
      "type": "text",
      "id": "api_base",
      "label": "API base URL",
      "default": "https://api.tryme.com"
    }
  ]
}
{% endschema %}
```

> **Note:** `api_base` is a merchant-visible theme-editor setting (not something read from Liquid globals) because the API's base URL is a deployment detail the merchant never needs to think about day-to-day, but it must be settable per-environment (this session's own testing used `https://wispy-plaza-mullets.ngrok-free.dev`, production will use a real domain) — this is the one exception to the spec's "no merchant-configurable settings" note, and it's a URL, not app behavior, so it doesn't complicate setup (it has a sensible default).

- [ ] **Step 3: Write the locale strings**

Create `apps/shopify-extension/locales/en.default.json`:

```json
{
  "tryon": {
    "button_label": "Try It On",
    "upload_prompt": "Upload a photo of yourself to see how this looks on you.",
    "generating": "Generating your try-on...",
    "pending": "We're preparing this product for try-on. Check back in a moment.",
    "result_alt": "Your try-on result",
    "try_another": "Try another photo",
    "error": "Something went wrong. Please try again.",
    "try_again": "Try again"
  }
}
```

- [ ] **Step 4: Write the widget CSS**

Create `apps/shopify-extension/assets/tryon-widget.css`:

```css
.tryme-tryon__modal {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}

.tryme-tryon__modal[hidden] {
  display: none;
}

.tryme-tryon__modal-content {
  position: relative;
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  max-width: 480px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
}

.tryme-tryon__close {
  position: absolute;
  top: 8px;
  right: 12px;
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
}

.tryme-tryon__step[hidden] {
  display: none;
}

.tryme-tryon__result-image {
  max-width: 100%;
  border-radius: 4px;
}
```

- [ ] **Step 5: Write the widget JS**

Create `apps/shopify-extension/assets/tryon-widget.js`:

```js
(function () {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLL_ATTEMPTS = 60;

  function initWidget(root) {
    const widgetKey = root.dataset.widgetKey;
    const productId = Number(root.dataset.productId);
    const apiBase = root.dataset.apiBase.replace(/\/$/, '');

    const button = root.querySelector('.tryme-tryon__button');
    const modal = root.querySelector('.tryme-tryon__modal');
    const closeBtn = root.querySelector('.tryme-tryon__close');
    const fileInput = root.querySelector('.tryme-tryon__file-input');
    const steps = {
      upload: root.querySelector('.tryme-tryon__step--upload'),
      progress: root.querySelector('.tryme-tryon__step--progress'),
      pending: root.querySelector('.tryme-tryon__step--pending'),
      result: root.querySelector('.tryme-tryon__step--result'),
      error: root.querySelector('.tryme-tryon__step--error'),
    };
    const resultImage = root.querySelector('.tryme-tryon__result-image');

    function showStep(name) {
      for (const key of Object.keys(steps)) {
        steps[key].hidden = key !== name;
      }
    }

    function openModal() {
      modal.hidden = false;
      showStep('upload');
      fileInput.value = '';
    }

    function closeModal() {
      modal.hidden = true;
    }

    async function uploadPhoto(file) {
      const presignRes = await fetch(`${apiBase}/v1/widget/presign`, {
        method: 'POST',
        headers: { 'x-widget-key': widgetKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
      });
      if (!presignRes.ok) throw new Error('presign failed');
      const { uploadUrl, r2Key } = await presignRes.json();

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error('upload failed');
      return r2Key;
    }

    async function createJob(customerPhotoKey) {
      const res = await fetch(`${apiBase}/v1/widget/jobs`, {
        method: 'POST',
        headers: { 'x-widget-key': widgetKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopifyProductId: productId, customerPhotoKey }),
      });
      if (res.status === 202) return { pending: true };
      if (!res.ok) throw new Error(`job create failed: ${res.status}`);
      const body = await res.json();
      return { pending: false, jobId: body.jobId };
    }

    async function pollJob(jobId) {
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const res = await fetch(`${apiBase}/v1/widget/jobs/${jobId}`, {
          headers: { 'x-widget-key': widgetKey },
        });
        if (!res.ok) throw new Error(`poll failed: ${res.status}`);
        const body = await res.json();
        if (body.status === 'COMPLETED') return body.resultUrl;
        if (body.status === 'FAILED') throw new Error('job failed');
      }
      throw new Error('polling timed out');
    }

    async function handleFile(file) {
      if (!file.type.startsWith('image/')) {
        showStep('error');
        return;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        showStep('error');
        return;
      }

      showStep('progress');
      try {
        const customerPhotoKey = await uploadPhoto(file);
        const jobResult = await createJob(customerPhotoKey);
        if (jobResult.pending) {
          showStep('pending');
          return;
        }
        const resultUrl = await pollJob(jobResult.jobId);
        resultImage.src = resultUrl;
        showStep('result');
      } catch (err) {
        showStep('error');
      }
    }

    button.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handleFile(file);
    });
    for (const retryBtn of root.querySelectorAll('.tryme-tryon__retry')) {
      retryBtn.addEventListener('click', () => {
        showStep('upload');
        fileInput.value = '';
      });
    }
  }

  document.querySelectorAll('.tryme-tryon').forEach(initWidget);
})();
```

> **Note on `POST /v1/widget/presign`'s request body:** confirm the exact expected body shape (`{ contentType, contentLength }` above is inferred from the route's `presignPut(key, contentType, contentLength, ttl)` call signature seen in `apps/api/src/modules/widget/routes.ts:119` during this session) by reading that route handler directly before finalizing this step — if the real request body shape differs (e.g. it also needs a `filename`), update this fetch call to match reality, not this plan's guess.

- [ ] **Step 6: Deploy the extension**

```bash
cd apps/shopify-extension
shopify app deploy
```

This creates a new version of the Partner app including this extension. Confirm the deploy succeeds and note any `SHOPIFY_<EXTENSION_NAME>_ID` value it writes to a local `.env` (per Shopify CLI convention) — do not commit that file if it contains anything env-specific beyond an ID reference.

- [ ] **Step 7: Manual verification against the real dev store**

1. In the `ai-vastra-store` (or `tryme`) dev store's theme editor, open the product template, add the "Try It On" app block, save.
2. View the live product page on the storefront. Confirm the button renders (proves the metafield read + Task 3's write worked).
3. Click it, upload a real photo, confirm: modal opens, upload succeeds, job creates (may hit the 202 "preparing" path if that product was never synced with an active garment — check `shopify_product_garments` for that product's `status` first via the same `docker exec tryme-postgres psql` pattern used throughout this session, and if `active`, expect a real job to create and poll through to a result or failure, depending on whether a `workflowTemplateId` + `'shopify'`-capable worker are configured, per the existing operational prerequisites from Task 10).
4. Confirm no internal error text/codes are ever visible in the UI, only the generic messages from `en.default.json`.

- [ ] **Step 8: Commit**

```bash
git add apps/shopify-extension/
git commit -m "feat(shopify-extension): try-on button + upload modal theme app extension"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** CORS fix (Task 1), metafield write (Task 3), `resultUrl` field (Task 2), theme extension file structure/modal flow/error handling (Task 4) all map 1:1 to the spec's sections. Testing approach section is reflected in Task 4 having no TDD steps, only manual verification, as the spec calls for.
- **Type/name consistency checked:** `writeWidgetKeyMetafield`'s signature (Task 3) matches its call site (Task 3 Step 5) and its test (Task 3 Step 1). `resultUrl`'s field name matches between Task 2's implementation and Task 4's JS (`body.resultUrl`). `x-widget-key` header name matches across Tasks 1, 2, 3, and 4's JS.
- **Known gap, flagged not silently fixed:** Task 3's metafield write has no test coverage through the real HTTP callback route (same pre-existing gap noted in Task 6 of the original backend plan — `shopify-oauth.test.ts` only ever called `upsertShopifyStore` directly). Extracting `writeWidgetKeyMetafield` as its own injectable-fetch function (Task 3) gives it direct unit coverage despite this, which is the best achievable coverage without a larger, out-of-scope refactor of the callback route's own test strategy.
