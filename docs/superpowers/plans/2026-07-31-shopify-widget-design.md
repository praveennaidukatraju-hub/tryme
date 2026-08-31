# Shopify Widget Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the try-on button from a Shopify app embed to a product-template app block, and add a Widget Design page that lets merchants control the try-on modal's accent color, copy, and result-step actions with a live preview.

**Architecture:** Merchant config is stored in the existing `shopify_stores.settings` jsonb column and mirrored to an `tryme.widget_config` shop metafield, which Liquid reads server-side — no per-page-view request and no flash of default copy. Postgres is authoritative; the metafield is a cache, and a failed mirror write returns `synced: false` with HTTP 200 so the page can offer a republish retry. The button becomes an app block the merchant drags into the product template, which deletes the entire CSS-selector-guessing placement path.

**Tech Stack:** Fastify 5 + Zod, Drizzle ORM, Shopify Admin GraphQL API (`metafieldsSet`), Shopify theme app extension (Liquid + vanilla JS), React 18 + Polaris 13 + react-router-dom 7, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-shopify-widget-design-design.md`

## Global Constraints

- **This plan must execute after `docs/superpowers/plans/2026-07-31-shopify-shopper-limits.md` Tasks 6 and 7.** Task 6 adds email-gate markup to `tryon-block.liquid` and identity code to `tryon-widget.js`. Task 3 below **deletes** `tryon-block.liquid` — that email-gate markup must be carried into `tryon-button.liquid` verbatim, or the email gate silently disappears.
- Every merchant-authored string rendered in Liquid MUST pass through `| escape`. Liquid does not auto-escape.
- Default copy strings MUST NOT contain a single-quote character — Liquid string literals in this file use single quotes, and the drift test in Task 7 parses them with a single-quote-delimited regex.
- No `console.log` in committed code (widget JS may use `console.warn` for merchant-facing diagnostics only).
- ESM only, `"type": "module"` everywhere. pnpm workspaces — never introduce npm/yarn lockfiles.
- Postgres and Redis bind to `127.0.0.1` only. `pnpm docker:up` must be running before any integration test.
- Absent config always means "behave exactly as today". No existing store may change appearance until a merchant opts in.

---

## Spec Corrections Applied In This Plan

Three things in the spec do not survive contact with the real code. The plan implements the corrected version; the spec text is superseded on these points only.

1. **Metafield write uses GraphQL `metafieldsSet`, not `POST /metafields.json`.** REST `POST` 422s when a metafield with the same namespace/key already exists. `writeWidgetKeyMetafield` escapes this because it runs once at install. Widget config is saved repeatedly, so it needs a real upsert.
2. **No `useBlocker`.** `apps/shopify/src/main.tsx` uses `<BrowserRouter>`; `useBlocker` requires a data router (`createBrowserRouter`) and throws otherwise. Task 8 adds a small nav-guard module instead.
3. **`WIDGET_COPY_DEFAULTS` lives in `apps/shopify/src/lib/widgetDefaults.ts`, not `packages/types`.** `apps/shopify/package.json` has no `@tryme/types` dependency — it hand-duplicates types in `src/types.ts`, which keeps zod out of the SPA bundle. The server never needs the defaults: it stores nulls and Liquid supplies the fallbacks.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid` | The app block — button markup, modal markup, metafield-driven copy, block settings schema |
| `apps/api/src/modules/shopify/widget-config.routes.ts` | `PATCH /v1/shopify/widget-config` and `POST /v1/shopify/widget-config/republish` |
| `apps/api/src/modules/shopify/metafields.test.ts` | Unit tests for both metafield writers |
| `apps/api/test/shopify-widget-config.test.ts` | Integration tests for the two endpoints |
| `apps/api/src/modules/shopify/onboarding.test.ts` | Unit test for the app-block deep link |
| `apps/shopify/src/lib/widgetDefaults.ts` | `WIDGET_COPY_DEFAULTS` — the single JS-side source of default copy |
| `apps/shopify/src/lib/navGuard.ts` | Module-level unsaved-changes guard consulted by both nav call sites |
| `apps/shopify/src/components/WidgetPreview.tsx` | Pixel-accurate modal preview using the real widget stylesheet |
| `apps/shopify/src/pages/WidgetDesignPage.tsx` | The merchant-facing page — form, preview, save bar, sync banner |
| `apps/shopify/src/assets/sample-photo.jpg` | Ready-tab placeholder |
| `apps/shopify/src/assets/sample-result.jpg` | Result-tab placeholder |
| `apps/shopify/vitest.config.ts` | Test runner config for the SPA |
| `apps/shopify/src/__tests__/widget-drift.test.ts` | Two drift guards binding the preview to the Liquid |

**Modified**

| File | Change |
|---|---|
| `packages/db/src/schema/shopify.ts` | Three config interfaces + `ShopifyStoreSettings.widget` |
| `packages/types/src/widget.ts` | `ShopifyWidgetConfigPatch` Zod schema |
| `apps/api/src/modules/shopify/metafields.ts` | `writeWidgetConfigMetafield` via GraphQL `metafieldsSet` |
| `apps/api/src/modules/shopify/onboarding.routes.ts` | Block handle, deep-link shape, stale comment |
| `apps/api/src/modules/shopify/routes.ts` | Register the new route module |
| `.../assets/tryon-widget.js` | Delete placement path; add cart + share handlers |
| `.../assets/tryon-widget.css` | Accent variable chain; result-action styles |
| `apps/shopify/src/App.tsx` | `/widget-design` route; nav-guard wiring |
| `apps/shopify/src/components/AppNavMenu.tsx` | Nav entry; nav-guard wiring |
| `apps/shopify/src/lib/appBridge.ts` | `ui-save-bar` JSX + `saveBar` on `Window['shopify']` |
| `apps/shopify/src/types.ts` | Client-side widget config types |
| `apps/shopify/src/pages/DashboardPage.tsx` | Onboarding card copy — the block is now mandatory |
| `apps/shopify/package.json` | vitest devDependency + `test` script |

**Deleted**

- `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`

---

## Task 1: Config types, Zod schema, and the metafield writer

**Files:**
- Modify: `packages/db/src/schema/shopify.ts` (near line 34, alongside `ShopifyStoreSettings`)
- Modify: `packages/types/src/widget.ts` (append at end of file)
- Modify: `apps/api/src/modules/shopify/metafields.ts`
- Test: `apps/api/src/modules/shopify/metafields.test.ts` (create)

**Interfaces:**
- Consumes: nothing — this is the base task.
- Produces:
  - `ShopifyWidgetTheme`, `ShopifyWidgetCopy`, `ShopifyWidgetBehavior`, `ShopifyWidgetConfig` from `@tryme/db`
  - `ShopifyStoreSettings.widget?: ShopifyWidgetConfig`
  - `ShopifyWidgetConfigPatch` (Zod schema + inferred type) from `@tryme/types`
  - `writeWidgetConfigMetafield(shop: string, accessToken: string, shopifyShopId: number, config: ShopifyWidgetConfig, log: FastifyBaseLogger, fetchFn?: typeof fetch): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/shopify/metafields.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { writeWidgetConfigMetafield } from './metafields.js';

const log = { error: vi.fn(), info: vi.fn() } as never;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('writeWidgetConfigMetafield', () => {
  it('posts a metafieldsSet mutation scoped to the shop and returns true', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ data: { metafieldsSet: { userErrors: [] } } }),
    );

    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      4242,
      { theme: { accentColor: '#ff0000' } },
      log,
      fetchFn as unknown as typeof fetch,
    );

    expect(ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/graphql.json');
    const sent = JSON.parse((init as RequestInit).body as string);
    const mf = sent.variables.metafields[0];
    expect(mf.ownerId).toBe('gid://shopify/Shop/4242');
    expect(mf.namespace).toBe('tryme');
    expect(mf.key).toBe('widget_config');
    expect(mf.type).toBe('json');
    expect(JSON.parse(mf.value)).toEqual({ theme: { accentColor: '#ff0000' } });
  });

  it('returns false when Shopify reports userErrors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { metafieldsSet: { userErrors: [{ field: ['value'], message: 'bad' }] } },
      }),
    );

    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com', 'tok', 1, {}, log, fetchFn as unknown as typeof fetch,
    );

    expect(ok).toBe(false);
  });

  it('returns false on a non-ok HTTP response instead of throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com', 'tok', 1, {}, log, fetchFn as unknown as typeof fetch,
    );
    expect(ok).toBe(false);
  });

  it('returns false when the network call throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('boom'));
    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com', 'tok', 1, {}, log, fetchFn as unknown as typeof fetch,
    );
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- metafields`
Expected: FAIL — `writeWidgetConfigMetafield` is not exported from `./metafields.js`.

- [ ] **Step 3: Add the config interfaces to the DB schema**

In `packages/db/src/schema/shopify.ts`, insert immediately **above** `export interface ShopifyStoreSettings`:

```ts
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
```

Then add one line to `ShopifyStoreSettings`:

```ts
export interface ShopifyStoreSettings {
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
  limits?: ShopifyStoreLimits;
  retention?: ShopifyStoreRetention;
  widget?: ShopifyWidgetConfig;
}
```

No migration. `settings` is an existing `jsonb` column.

- [ ] **Step 4: Add the Zod patch schema**

Append to `packages/types/src/widget.ts`:

```ts
/**
 * Merchant-editable try-on modal config. Every field is optional and nullable:
 * absent means "leave whatever is stored", null means "clear back to the
 * Liquid default". Maximums exist so a merchant cannot paste an essay into a
 * 400px-wide modal — over-length is a 400, never a silent truncate.
 */
const widgetText = (max: number) => z.string().max(max).nullable().optional();

export const ShopifyWidgetConfigPatch = z.object({
  theme: z
    .object({
      accentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color')
        .nullable()
        .optional(),
    })
    .optional(),
  copy: z
    .object({
      heading: widgetText(60),
      subheading: widgetText(80),
      uploadTitle: widgetText(80),
      uploadLead: widgetText(160),
      chooseLabel: widgetText(40),
      ctaLabel: widgetText(40),
      legalText: widgetText(300),
      generatingText: widgetText(80),
      errorText: widgetText(160),
    })
    .optional(),
  behavior: z
    .object({
      addToCart: z.boolean().optional(),
      addToCartLabel: widgetText(30),
      share: z.boolean().optional(),
      shareLabel: widgetText(30),
    })
    .optional(),
});
export type ShopifyWidgetConfigPatch = z.infer<typeof ShopifyWidgetConfigPatch>;
```

- [ ] **Step 5: Implement the metafield writer**

Append to `apps/api/src/modules/shopify/metafields.ts`:

```ts
// GraphQL, not REST POST /metafields.json: that endpoint 422s when a metafield
// with the same namespace/key already exists. writeWidgetKeyMetafield above
// gets away with REST because it runs exactly once, at install. Widget config
// is re-saved every time the merchant edits it, so it needs a real upsert —
// which is what metafieldsSet is.
const METAFIELDS_SET = `
  mutation SetWidgetConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

export async function writeWidgetConfigMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  config: ShopifyWidgetConfig,
  log: FastifyBaseLogger,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await shopifyAdminFetch(
      shop,
      accessToken,
      '/graphql.json',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: METAFIELDS_SET,
          variables: {
            metafields: [
              {
                ownerId: `gid://shopify/Shop/${shopifyShopId}`,
                namespace: 'tryme',
                key: 'widget_config',
                type: 'json',
                value: JSON.stringify(config),
              },
            ],
          },
        }),
      },
      fetchFn,
    );

    if (!res.ok) {
      log.error({ shop, status: res.status }, 'failed to write widget_config metafield');
      return false;
    }

    // A GraphQL mutation can answer 200 and still have refused the write.
    const body = (await res.json()) as {
      data?: { metafieldsSet?: { userErrors?: { field: string[]; message: string }[] } };
    };
    const errors = body.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length > 0) {
      log.error({ shop, errors }, 'shopify rejected widget_config metafield');
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err, shop }, 'failed to write widget_config metafield');
    return false;
  }
}
```

Add `ShopifyWidgetConfig` to the imports at the top of the file:

```ts
import type { ShopifyWidgetConfig } from '@tryme/db';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- metafields`
Expected: PASS, 4 tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/types/src/widget.ts \
        apps/api/src/modules/shopify/metafields.ts \
        apps/api/src/modules/shopify/metafields.test.ts
git commit -m "feat(shopify): widget config types and metafield writer"
```

---

## Task 2: Widget config endpoints

**Files:**
- Create: `apps/api/src/modules/shopify/widget-config.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Test: `apps/api/test/shopify-widget-config.test.ts` (create)

**Interfaces:**
- Consumes: `ShopifyWidgetConfigPatch` from `@tryme/types`; `writeWidgetConfigMetafield(shop, accessToken, shopifyShopId, config, log, fetchFn?)` from `./metafields.js`; `getValidAccessToken(app, store)` from `./token.js`.
- Produces: `shopifyWidgetConfigRoutes(app: FastifyInstance)`. Endpoints:
  - `PATCH /v1/shopify/widget-config` → `{ widget: ShopifyWidgetConfig, synced: boolean }`
  - `POST /v1/shopify/widget-config/republish` → `{ synced: boolean }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-widget-config.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

// Every metafieldsSet call in this file goes through the stubbed global fetch,
// following apps/api/test/shopify-catalog-publish.test.ts. Without the stub the
// tests would make real network calls to m.myshopify.com.
function stubShopifyOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function stubShopifyFailure() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 77,
      shopDomain: 'w.myshopify.com',
      myshopifyDomain: 'w.myshopify.com',
      name: 'W',
      email: 'w@w.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('w.myshopify.com', API_SECRET, API_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

async function patch(body: unknown) {
  return app.inject({
    method: 'PATCH',
    url: '/v1/shopify/widget-config',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function readSettings() {
  const [row] = await app.db
    .select({ settings: schema.shopifyStores.settings })
    .from(schema.shopifyStores)
    .where(eq(schema.shopifyStores.id, storeId));
  return row.settings;
}

describe('PATCH /v1/shopify/widget-config', () => {
  it('stores config and reports synced', async () => {
    stubShopifyOk();
    const res = await patch({ theme: { accentColor: '#123abc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      widget: { theme: { accentColor: '#123abc' } },
      synced: true,
    });
    expect((await readSettings()).widget?.theme?.accentColor).toBe('#123abc');
  });

  it('merges within a sub-object instead of replacing it', async () => {
    stubShopifyOk();
    await patch({ copy: { heading: 'Hello' } });
    await patch({ copy: { subheading: 'World' } });
    const settings = await readSettings();
    expect(settings.widget?.copy).toEqual({ heading: 'Hello', subheading: 'World' });
  });

  it('does not clobber sibling settings keys', async () => {
    stubShopifyOk();
    await app.db
      .update(schema.shopifyStores)
      .set({
        settings: {
          themeBlockConfirmed: true,
          limits: { storeDailyCap: 50 },
          retention: { resultDays: 30 },
        },
      })
      .where(eq(schema.shopifyStores.id, storeId));

    await patch({ behavior: { addToCart: false } });

    const settings = await readSettings();
    expect(settings.themeBlockConfirmed).toBe(true);
    expect(settings.limits?.storeDailyCap).toBe(50);
    expect(settings.retention?.resultDays).toBe(30);
    expect(settings.widget?.behavior?.addToCart).toBe(false);
  });

  it('rejects a malformed accent color', async () => {
    stubShopifyOk();
    const res = await patch({ theme: { accentColor: 'red' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects over-length copy', async () => {
    stubShopifyOk();
    const res = await patch({ copy: { heading: 'x'.repeat(61) } });
    expect(res.statusCode).toBe(400);
  });

  it('still saves and returns synced:false when the metafield write fails', async () => {
    stubShopifyFailure();
    const res = await patch({ copy: { ctaLabel: 'Go' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().synced).toBe(false);
    expect((await readSettings()).widget?.copy?.ctaLabel).toBe('Go');
  });
});

describe('POST /v1/shopify/widget-config/republish', () => {
  it('pushes the stored config without writing the row', async () => {
    stubShopifyOk();
    await patch({ copy: { heading: 'Stable' } });
    const before = await readSettings();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/widget-config/republish',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ synced: true });
    expect(await readSettings()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-widget-config`
Expected: FAIL — every request 404s, the route module does not exist.

- [ ] **Step 3: Implement the route module**

Create `apps/api/src/modules/shopify/widget-config.routes.ts`:

```ts
import type { ShopifyWidgetConfig } from '@tryme/db';
import { schema } from '@tryme/db';
import { ShopifyWidgetConfigPatch } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { writeWidgetConfigMetafield } from './metafields.js';
import { getValidAccessToken } from './token.js';

type Store = typeof schema.shopifyStores.$inferSelect;

/**
 * Mirror the stored config into the shop metafield Liquid reads.
 *
 * Token acquisition is deliberately OUTSIDE the writer's own try/catch: a dead
 * or scope-stale token throws SHOPIFY_REAUTH_REQUIRED, which the SPA turns into
 * a one-click reauth. Swallowing it into `synced: false` would show the merchant
 * a "retry" button that can never succeed.
 */
async function publishConfig(
  app: FastifyInstance,
  store: Store,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const accessToken = await getValidAccessToken(app, store);
  return writeWidgetConfigMetafield(
    store.shopDomain,
    accessToken,
    store.shopifyShopId,
    store.settings.widget ?? {},
    log,
  );
}

export async function shopifyWidgetConfigRoutes(app: FastifyInstance) {
  app.patch(
    '/v1/shopify/widget-config',
    { preValidation: app.requireShopifySession, schema: { body: ShopifyWidgetConfigPatch } },
    async (req) => {
      const store = req.shopifyStore as Store;
      const body = req.body as ShopifyWidgetConfigPatch;
      const current = store.settings.widget ?? {};

      // Shallow-merge each sub-object so a PATCH touching only `copy` cannot
      // drop `theme` or `behavior`, and so patching one copy field cannot drop
      // the other eight.
      const widget: ShopifyWidgetConfig = {
        ...current,
        ...(body.theme ? { theme: { ...current.theme, ...body.theme } } : {}),
        ...(body.copy ? { copy: { ...current.copy, ...body.copy } } : {}),
        ...(body.behavior ? { behavior: { ...current.behavior, ...body.behavior } } : {}),
      };
      const settings = { ...store.settings, widget };

      await app.db
        .update(schema.shopifyStores)
        .set({ settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));

      // Postgres is authoritative and already committed. The metafield is a
      // cache, so a failed mirror is reported as synced:false on a 200 — a 5xx
      // here would tell the merchant their copy was lost when it was not.
      const synced = await publishConfig(app, { ...store, settings }, req.log);

      req.log.info(
        { storeId: store.id, changed: Object.keys(body), synced },
        'shopify widget config updated',
      );
      return { widget, synced };
    },
  );

  app.post(
    '/v1/shopify/widget-config/republish',
    { preValidation: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as Store;
      const synced = await publishConfig(app, store, req.log);
      req.log.info({ storeId: store.id, synced }, 'shopify widget config republished');
      return { synced };
    },
  );
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/modules/shopify/routes.ts`, add the import alongside the others:

```ts
import { shopifyWidgetConfigRoutes } from './widget-config.routes.js';
```

and register it immediately after `shopifySettingsRoutes`:

```ts
  await app.register(shopifySettingsRoutes);
  await app.register(shopifyWidgetConfigRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-widget-config`
Expected: PASS, 7 tests. (`pnpm docker:up` must be running.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/widget-config.routes.ts \
        apps/api/src/modules/shopify/routes.ts \
        apps/api/test/shopify-widget-config.test.ts
git commit -m "feat(shopify): widget config patch and republish endpoints"
```

---

## Task 3: Migrate the button from app embed to app block

This task changes **only** the delivery mechanism. The rendered markup and copy stay byte-identical to today; config-driven copy arrives in Task 4. Keeping these separate means a reviewer can confirm "nothing about the storefront changed except where the button lives".

**Files:**
- Create: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`
- Delete: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js:492-543`
- Modify: `apps/api/src/modules/shopify/onboarding.routes.ts:8-38`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx:210-213`
- Test: `apps/api/src/modules/shopify/onboarding.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: block handle `tryon-button`; `buildThemeEditorDeepLink(shopDomain: string, apiKey: string): string` returning an `addAppBlockId` URL.

> **Carry-over requirement:** if shopper-limits Task 6 has landed, `tryon-block.liquid` contains an email-gate step (`.tryme-tryon__step--email` or similar). Copy that markup into the new file verbatim before deleting the old one. Verify with `git show HEAD:apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid | grep -i email` — if it prints nothing, Task 6 has not landed and there is nothing to carry.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/shopify/onboarding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildThemeEditorDeepLink } from './onboarding.routes.js';

describe('buildThemeEditorDeepLink', () => {
  it('targets the product template main section with the app block', () => {
    const url = buildThemeEditorDeepLink('s.myshopify.com', 'apikey123');
    expect(url).toBe(
      'https://s.myshopify.com/admin/themes/current/editor' +
        '?template=product&addAppBlockId=apikey123/tryon-button&target=mainSection',
    );
  });

  it('no longer uses the app-embed activation parameter', () => {
    expect(buildThemeEditorDeepLink('s.myshopify.com', 'k')).not.toContain('activateAppId');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- onboarding`
Expected: FAIL — the URL still contains `?context=apps&activateAppId=...`.

- [ ] **Step 3: Create the app block**

Create `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`. Take the **entire body** of `tryon-block.liquid` from `{%- assign widget_key -%}` through `{%- endif -%}` (lines 18-156) unchanged, then apply exactly these edits:

1. Replace the leading `{% comment %}` block (lines 1-16) with:

```liquid
{% comment %}
  Renders a "Try It On" button + upload modal for the current product.

  App BLOCK (not an app embed): the merchant drags this into their product
  template in the theme editor, so it renders exactly where they put it. That
  is why there is no placement_selector setting and no placement JS — the
  previous app-embed version injected at the end of <body> and then had to
  relocate itself through a chain of guessed CSS selectors, which broke every
  time a merchant switched themes.

  App blocks require an Online Store 2.0 (JSON) template. Vintage themes cannot
  accept them and are unsupported.

  `enabled_on.templates` pins this to product templates: `product` is blank
  everywhere else, so the guard below would render nothing anyway, and the
  block would just be dead weight in the theme editor's picker.
{% endcomment %}
```

2. Delete these two attributes from the root `<div class="tryme-tryon">`:

```liquid
    data-placement-selector="{{ block.settings.placement_selector }}"
    data-block-alignment="{{ block.settings.block_alignment }}"
```

3. Replace the whole `{% schema %}` block with:

```liquid
{% schema %}
{
  "name": "Try It On",
  "target": "section",
  "enabled_on": { "templates": ["product"] },
  "settings": [
    {
      "type": "text",
      "id": "api_base",
      "label": "API base URL",
      "default": "https://app.tryme.com"
    },
    {
      "type": "text",
      "id": "promo_text",
      "label": "Promotional text above button"
    },
    {
      "type": "text",
      "id": "button_text",
      "label": "Button text",
      "default": "Try It On"
    },
    {
      "type": "color",
      "id": "text_color",
      "label": "Text color",
      "default": "#FFFFFF"
    },
    {
      "type": "color",
      "id": "button_color",
      "label": "Button color",
      "default": "#000000"
    },
    {
      "type": "range",
      "id": "border_radius",
      "label": "Border radius",
      "min": 0,
      "max": 20,
      "step": 1,
      "unit": "px",
      "default": 4
    }
  ]
}
{% endschema %}
```

- [ ] **Step 4: Delete the app embed**

```bash
git rm apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid
```

- [ ] **Step 5: Delete the placement path from the widget JS**

In `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`, delete lines 492-539 in their entirety — the `FALLBACK_PLACEMENT_SELECTORS` comment and array, and the whole `placeWidget` function.

Then replace the boot loop at lines 541-545:

```js
  const widgets = document.querySelectorAll('.tryme-tryon');
  for (let i = 0; i < widgets.length; i++) {
    placeWidget(widgets[i]);
    initWidget(widgets[i]);
  }
```

with:

```js
  // No placement step: the merchant positioned this block in the theme editor,
  // so it already renders where it belongs.
  const widgets = document.querySelectorAll('.tryme-tryon');
  for (let i = 0; i < widgets.length; i++) {
    initWidget(widgets[i]);
  }
```

- [ ] **Step 6: Update the deep link**

In `apps/api/src/modules/shopify/onboarding.routes.ts`, change line 12:

```ts
const TRYON_BLOCK_HANDLE = 'tryon-button';
```

Replace the doc comment at lines 14-32 and the function body with:

```ts
/**
 * Deep link into the merchant's live theme editor with our app block staged for
 * insertion into the product template.
 *
 * Deliberately builds a URL instead of asking the Admin API for the theme ID.
 * The obvious implementation — GET /themes.json?role=main — needs the
 * `read_themes` scope, which this app does not request (see `scopes` in
 * apps/shopify-extension/shopify.app.toml). Shopify answers that call with a
 * 403, `shopifyAdminFetch` turns every 403 into SHOPIFY_REAUTH_REQUIRED, and
 * the SPA then bounces the merchant through OAuth — which re-grants the same
 * scope set and 403s again on the next click. An unbreakable loop on the one
 * button new merchants are told to press first.
 *
 * `themes/current` resolves the published theme server-side, so no theme ID is
 * needed. `addAppBlockId` is `{client_id}/{block handle}` and stages the block
 * for insertion; `template=product` and `target=mainSection` tell the editor
 * which template to open and which section to drop it into. This replaced an
 * `activateAppId` app-embed link — app embeds are injected globally by Shopify,
 * app blocks are placed by the merchant, and the two use different parameters.
 */
export function buildThemeEditorDeepLink(shopDomain: string, apiKey: string): string {
  return (
    `https://${shopDomain}/admin/themes/current/editor` +
    `?template=product&addAppBlockId=${apiKey}/${TRYON_BLOCK_HANDLE}&target=mainSection`
  );
}
```

Also update the comment on line 8, which names the old file:

```ts
 * `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`
```

- [ ] **Step 7: Update the Dashboard onboarding copy**

In `apps/shopify/src/pages/DashboardPage.tsx`, replace the `StepRow` at lines 209-213's title and description:

```tsx
                <StepRow
                  done={themeBlockDone}
                  title="Add the Try It On block to your product page"
                  description="Required — the try-on button only appears where you place this block. Open the theme editor, then save."
                >
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- onboarding`
Expected: PASS, 2 tests.

- [ ] **Step 9: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add -A apps/shopify-extension apps/api/src/modules/shopify/onboarding.routes.ts \
           apps/api/src/modules/shopify/onboarding.test.ts \
           apps/shopify/src/pages/DashboardPage.tsx
git commit -m "feat(shopify): move try-on button from app embed to product app block"
```

---

## Task 4: Metafield-driven copy and accent color

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css` (lines 265, 329, 435, 475)

**Interfaces:**
- Consumes: the metafield written by Task 2 — `shop.metafields.tryme.widget_config.value` with shape `{ theme: { accentColor }, copy: {...}, behavior: {...} }`.
- Produces: the exact `| default:` strings that Task 7's drift test asserts against `WIDGET_COPY_DEFAULTS`.

**Verification for this task is manual** — a dev store. There is no test runner inside the theme extension, and introducing one for Liquid rendering is out of scope. Task 7's drift tests cover the defaults contract; the visual result is checked by eye.

- [ ] **Step 1: Read the config at the top of the block**

In `tryon-button.liquid`, immediately after the existing `{%- assign widget_key -%}` line, add:

```liquid
{%- assign cfg = shop.metafields.tryme.widget_config.value -%}
```

Liquid returns nil for property access on nil, so with no metafield written yet
every `cfg.copy.x` below is nil and every `| default:` fires. Fresh installs and
stores that never open the Widget Design page render exactly as they do today.

- [ ] **Step 2: Add the accent variable to the root element**

Replace the root `style` attribute with:

```liquid
    style="--tryme-button-color: {{ block.settings.button_color }}; --tryme-text-color: {{ block.settings.text_color }}; --tryme-border-radius: {{ block.settings.border_radius }}px;{% if cfg.theme.accentColor %} --tryme-accent: {{ cfg.theme.accentColor | escape }};{% endif %}"
```

- [ ] **Step 3: Replace every hardcoded modal string**

Apply these substitutions in `tryon-button.liquid`. Left column is the current literal, right column is the replacement.

| Current | Replacement |
|---|---|
| `<p class="tryme-tryon__heading">Try It On</p>` | `<p class="tryme-tryon__heading">{{ cfg.copy.heading \| default: 'Try It On' \| escape }}</p>` |
| `<p class="tryme-tryon__subheading">See how it looks on you</p>` | `<p class="tryme-tryon__subheading">{{ cfg.copy.subheading \| default: 'See how it looks on you' \| escape }}</p>` |
| `<h2 class="tryme-tryon__upload-title">Ready to try it on?</h2>` | `<h2 class="tryme-tryon__upload-title">{{ cfg.copy.uploadTitle \| default: 'Ready to try it on?' \| escape }}</h2>` |
| `Upload your photo and see how it looks on you instantly` | `{{ cfg.copy.uploadLead \| default: 'Upload your photo and see how it looks on you instantly' \| escape }}` |
| `<strong>Choose Your Photo</strong>` | `<strong>{{ cfg.copy.chooseLabel \| default: 'Choose Your Photo' \| escape }}</strong>` |
| `<span>{{ block.settings.button_text \| default: 'Try It On' \| escape }} Now</span>` | `<span>{{ cfg.copy.ctaLabel \| default: 'Try It On Now' \| escape }}</span>` |
| `<p>{{ 'tryon.generating' \| t }}</p>` | `<p>{{ cfg.copy.generatingText \| default: 'Generating your try-on...' \| escape }}</p>` |
| `<p>{{ 'tryon.error' \| t }}</p>` | `<p>{{ cfg.copy.errorText \| default: 'Something went wrong. Please try again.' \| escape }}</p>` |

Then replace **both** legal paragraphs — the one on the upload step and the
different one on the ready step — with the same single block. They were two
different sentences; they collapse into one configurable line:

```liquid
              <p class="tryme-tryon__legal">
                {{ cfg.copy.legalText | default: 'By using this service, you agree to our Terms and Privacy Policy.' | escape }}<br />
                AI can make mistakes.
              </p>
```

The `<br />` and "AI can make mistakes." stay as literal markup **outside** the
variable, so no merchant input can introduce a tag.

Leave untouched: `{{ 'tryon.pending' | t }}`, `{{ 'tryon.result_alt' | t }}`,
`{{ 'tryon.try_again' | t }}`, and the empty-history line — those are not
configurable (see spec §1).

- [ ] **Step 4: Wire the accent variable through the CSS**

In `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`, at each of lines **265**, **329**, **435**, and **475**, change:

```css
  background: var(--tryme-button-color, #000000);
```

to:

```css
  background: var(--tryme-accent, var(--tryme-button-color, #000000));
```

Leave line **131** alone. That is the storefront trigger button — the merchant's
theme-editor button, not the modal — and it keeps following the block setting.
Leave line **502** alone for the same reason.

- [ ] **Step 5: Verify on a dev store**

Deploy the extension and check, in order:

1. With no `widget_config` metafield: every string renders as before, the modal
   CTA reads "Try It On Now", and modal buttons are the block's button color.
2. `PATCH /v1/shopify/widget-config` with `{"theme":{"accentColor":"#e91e63"}}`,
   reload the product page: step dots, choose-photo, CTA and retry turn pink;
   the storefront trigger button does **not**.
3. `PATCH` with `{"copy":{"heading":"Fit Check"}}`, reload: the modal header
   reads "Fit Check".
4. `PATCH` with `{"copy":{"heading":"<b>x</b>"}}`, reload: the header shows the
   literal text `<b>x</b>`, not bold text. If it renders bold, an `| escape` is
   missing.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid \
        apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css
git commit -m "feat(shopify): drive modal copy and accent color from store config"
```

---

## Task 5: Add to Cart and Share on the result step

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`

**Interfaces:**
- Consumes: `cfg.behavior.{addToCart,addToCartLabel,share,shareLabel}` from Task 1's config shape.
- Produces: DOM classes `tryme-tryon__result-actions`, `tryme-tryon__add-to-cart`, `tryme-tryon__share`, `tryme-tryon__view-cart`, `tryme-tryon__cart-error`, `tryme-tryon__share-flash` — Task 7's drift test checks the preview only uses classes that exist here.

**Verification is manual** (dev store), for the same reason as Task 4.

- [ ] **Step 1: Add the result-step markup**

In `tryon-button.liquid`, replace the result step:

```liquid
            <div class="tryme-tryon__step tryme-tryon__step--result" hidden>
              <img class="tryme-tryon__result-image" alt="{{ 'tryon.result_alt' | t }}" />
            </div>
```

with:

```liquid
            <div class="tryme-tryon__step tryme-tryon__step--result" hidden>
              <img class="tryme-tryon__result-image" alt="{{ 'tryon.result_alt' | t }}" />

              <div class="tryme-tryon__result-actions">
                {%- unless cfg.behavior.addToCart == false -%}
                  <button
                    type="button"
                    class="tryme-tryon__add-to-cart"
                    data-default-variant-id="{{ product.selected_or_first_available_variant.id }}"
                  >
                    {{ cfg.behavior.addToCartLabel | default: 'Add to Cart' | escape }}
                  </button>
                {%- endunless -%}
                {%- unless cfg.behavior.share == false -%}
                  <button
                    type="button"
                    class="tryme-tryon__share"
                    aria-label="{{ cfg.behavior.shareLabel | default: 'Share' | escape }}"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 7.8-4.6M8 13l7.8 4.6"/></svg>
                  </button>
                {%- endunless -%}
              </div>

              <p class="tryme-tryon__cart-error" hidden></p>
              <span class="tryme-tryon__share-flash" hidden></span>
              <a class="tryme-tryon__view-cart" href="/cart" hidden>View cart</a>
            </div>
```

`unless … == false` rather than `if … == true`: an absent config must mean both
buttons are on.

- [ ] **Step 2: Add a shared share helper and use it for history cards**

In `tryon-widget.js`, inside `initWidget`, add these element lookups next to the
existing `const resultImage = …` line (around line 27):

```js
    const addToCartBtn = root.querySelector('.tryme-tryon__add-to-cart');
    const shareBtn = root.querySelector('.tryme-tryon__share');
    const viewCartLink = root.querySelector('.tryme-tryon__view-cart');
    const cartError = root.querySelector('.tryme-tryon__cart-error');
    const shareFlash = root.querySelector('.tryme-tryon__share-flash');
    const addToCartLabel = addToCartBtn ? addToCartBtn.textContent.trim() : '';
    let currentResultUrl = null;
```

Then add this helper inside `initWidget` (anywhere above `renderHistoryList`):

```js
    // navigator.share is absent on desktop Firefox and older Safari. The
    // payload is a plain public URL either way, so the fallback is a clipboard
    // copy rather than hiding the affordance — a share button that vanishes on
    // some browsers leaves the result actions visibly lopsided.
    function shareResult(url) {
      if (!url) return;
      if (typeof navigator.share === 'function') {
        navigator.share({ url }).catch(() => {
          /* user cancelled the share sheet — nothing to do */
        });
        return;
      }
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(url).then(
        () => flashShare('Link copied'),
        () => flashShare('Copy failed'),
      );
    }

    let shareFlashTimer = null;
    function flashShare(message) {
      if (!shareFlash) return;
      shareFlash.textContent = message;
      shareFlash.hidden = false;
      clearTimeout(shareFlashTimer);
      shareFlashTimer = setTimeout(() => {
        shareFlash.hidden = true;
      }, 2000);
    }
```

In `renderHistoryList`, replace the guarded block at lines 231-244:

```js
        if (typeof navigator.share === 'function') {
          const shareBtn = document.createElement('button');
          ...
          shareBtn.addEventListener('click', () => {
            navigator.share({ url: entry.resultUrl }).catch(() => {
              /* user cancelled the share sheet — nothing to do */
            });
          });
          actions.appendChild(shareBtn);
        }
```

with an unguarded version that delegates to the helper:

```js
        const historyShareBtn = document.createElement('button');
        historyShareBtn.type = 'button';
        historyShareBtn.className = 'tryme-tryon__history-share';
        historyShareBtn.setAttribute('aria-label', 'Share');
        historyShareBtn.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 7.8-4.6M8 13l7.8 4.6"/></svg>';
        historyShareBtn.addEventListener('click', () => shareResult(entry.resultUrl));
        actions.appendChild(historyShareBtn);
```

- [ ] **Step 3: Add the cart handler**

Add inside `initWidget`, below `shareResult`:

```js
    // The shopper's live variant selection lives in the theme's own product
    // form, which every Shopify product page has. data-default-variant-id is
    // the Liquid-rendered fallback for themes that render the form lazily.
    function resolveVariantId() {
      const input = document.querySelector('form[action*="/cart/add"] [name="id"]');
      const fromForm = input ? Number(input.value) : 0;
      if (fromForm) return fromForm;
      const fallback = addToCartBtn ? Number(addToCartBtn.dataset.defaultVariantId) : 0;
      return fallback || null;
    }

    function resetResultActions() {
      if (addToCartBtn) {
        addToCartBtn.disabled = false;
        addToCartBtn.textContent = addToCartLabel;
      }
      if (viewCartLink) viewCartLink.hidden = true;
      if (cartError) {
        cartError.hidden = true;
        cartError.textContent = '';
      }
    }

    async function addCurrentVariantToCart() {
      const variantId = resolveVariantId();
      if (!variantId || !addToCartBtn) return;

      addToCartBtn.disabled = true;
      if (cartError) cartError.hidden = true;

      try {
        const res = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
        });

        if (!res.ok) {
          // Sold-out and every other refusal comes back as a 422 with a human
          // message. Showing Shopify's own string beats tracking variant
          // availability client-side across each theme's selector JS.
          const body = await res.json().catch(() => ({}));
          if (cartError) {
            cartError.textContent = body.description || 'Could not add to cart.';
            cartError.hidden = false;
          }
          addToCartBtn.disabled = false;
          return;
        }

        addToCartBtn.textContent = 'Added ✓';
        if (viewCartLink) viewCartLink.hidden = false;
        // Themes that listen refresh their cart badge; the rest ignore an
        // unknown event. Cheaper and safer than detecting each theme's drawer.
        document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
      } catch {
        if (cartError) {
          cartError.textContent = 'Could not add to cart.';
          cartError.hidden = false;
        }
        addToCartBtn.disabled = false;
      }
    }

    if (addToCartBtn) addToCartBtn.addEventListener('click', addCurrentVariantToCart);
    if (shareBtn) shareBtn.addEventListener('click', () => shareResult(currentResultUrl));
```

- [ ] **Step 4: Track the current result and reset the actions**

In `proceedWithPhoto` (around line 428), immediately after `const resultUrl = await waitForResult(jobResult.jobId);`, add:

```js
        currentResultUrl = resultUrl;
        resetResultActions();
```

so the state is:

```js
        const resultUrl = await waitForResult(jobResult.jobId);
        currentResultUrl = resultUrl;
        resetResultActions();
        resultImage.src = resultUrl;
        showPage('main');
        showStep('result');
        addToHistory(resultUrl);
```

Without the reset, a second try-on in the same session shows a disabled
"Added ✓" button for a product that was never added.

- [ ] **Step 5: Style the actions**

Append to `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`:

```css
.tryme-tryon__result-actions {
  display: flex;
  align-items: stretch;
  gap: 10px;
  margin-top: 14px;
}

.tryme-tryon__add-to-cart {
  flex: 1;
  padding: 14px 20px;
  border: none;
  border-radius: 12px;
  background: var(--tryme-accent, var(--tryme-button-color, #000000));
  color: var(--tryme-text-color, #ffffff);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}

.tryme-tryon__add-to-cart:disabled {
  opacity: 0.6;
  cursor: default;
}

.tryme-tryon__share {
  flex: 0 0 auto;
  width: 48px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  color: #111827;
  cursor: pointer;
}

.tryme-tryon__cart-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: #b42318;
}

.tryme-tryon__share-flash {
  display: inline-block;
  margin-top: 8px;
  font-size: 13px;
  color: #667085;
}

.tryme-tryon__view-cart {
  display: inline-block;
  margin-top: 8px;
  font-size: 14px;
  text-decoration: underline;
  color: #111827;
}
```

- [ ] **Step 6: Verify on a dev store**

1. Generate a try-on. Both buttons appear below the result.
2. Change the variant selector on the product page, then click Add to Cart.
   Open `/cart` — the **selected** variant is in it, quantity 1.
3. Button reads "Added ✓" and is disabled; a "View cart" link appeared.
4. Pick a sold-out variant and click Add to Cart: Shopify's own message appears
   under the buttons and the button re-enables.
5. Generate a second try-on: the button is back to "Add to Cart", enabled, with
   no leftover error and no "View cart" link.
6. On a phone, tap Share — the native share sheet opens with the result URL.
7. In desktop Firefox, click Share — "Link copied" flashes and the clipboard
   holds the result URL.
8. `PATCH` with `{"behavior":{"share":false}}` and reload: only Add to Cart
   renders.

- [ ] **Step 7: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension
git commit -m "feat(shopify): add to cart and share actions on try-on result"
```

---

## Task 6: Widget Design page and live preview

**Files:**
- Create: `apps/shopify/src/lib/widgetDefaults.ts`
- Create: `apps/shopify/src/components/WidgetPreview.tsx`
- Create: `apps/shopify/src/pages/WidgetDesignPage.tsx`
- Create: `apps/shopify/src/assets/sample-photo.jpg`, `apps/shopify/src/assets/sample-result.jpg`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppNavMenu.tsx`

**Interfaces:**
- Consumes: `PATCH /v1/shopify/widget-config` → `{ widget, synced }` from Task 2; `apiFetch<T>(path, init?)` from `./lib/api`.
- Produces:
  - `WIDGET_COPY_DEFAULTS` — a `Record<string, string>` of default copy, from `./lib/widgetDefaults`
  - `WidgetPreview` component, props `{ config: ShopifyWidgetConfig; step: PreviewStep }` where `PreviewStep = 'upload' | 'ready' | 'generating' | 'result' | 'error'`
  - `ShopifyWidgetConfig`, `ShopifyWidgetTheme`, `ShopifyWidgetCopy`, `ShopifyWidgetBehavior` in `apps/shopify/src/types.ts`

Save-bar behavior, dirty tracking and the sync-failure banner are **Task 8**. This task ships a plain "Save" button so the page is usable and reviewable on its own.

- [ ] **Step 1: Add the defaults module**

Create `apps/shopify/src/lib/widgetDefaults.ts`:

```ts
/**
 * Default modal copy. Must stay byte-identical to the `| default:` strings in
 * tryon-button.liquid — src/__tests__/widget-drift.test.ts fails the build if
 * they diverge. Liquid holds the authoritative fallbacks (the server stores
 * nulls); this copy exists so the form can show placeholders and the preview
 * can render something.
 *
 * No single quotes in any value: the Liquid literals are single-quoted and the
 * drift test parses them with a single-quote-delimited regex.
 */
export const WIDGET_COPY_DEFAULTS = {
  heading: 'Try It On',
  subheading: 'See how it looks on you',
  uploadTitle: 'Ready to try it on?',
  uploadLead: 'Upload your photo and see how it looks on you instantly',
  chooseLabel: 'Choose Your Photo',
  ctaLabel: 'Try It On Now',
  legalText: 'By using this service, you agree to our Terms and Privacy Policy.',
  generatingText: 'Generating your try-on...',
  errorText: 'Something went wrong. Please try again.',
} as const;

export const WIDGET_BEHAVIOR_DEFAULTS = {
  addToCartLabel: 'Add to Cart',
  shareLabel: 'Share',
} as const;

export type WidgetCopyField = keyof typeof WIDGET_COPY_DEFAULTS;

/** Field order and labels for the Copy card, and the max length each accepts. */
export const WIDGET_COPY_FIELDS: { key: WidgetCopyField; label: string; max: number }[] = [
  { key: 'heading', label: 'Modal heading', max: 60 },
  { key: 'subheading', label: 'Modal subheading', max: 80 },
  { key: 'uploadTitle', label: 'Upload title', max: 80 },
  { key: 'uploadLead', label: 'Upload instructions', max: 160 },
  { key: 'chooseLabel', label: 'Choose-photo button', max: 40 },
  { key: 'ctaLabel', label: 'Generate button', max: 40 },
  { key: 'legalText', label: 'Legal line', max: 300 },
  { key: 'generatingText', label: 'Generating message', max: 80 },
  { key: 'errorText', label: 'Error message', max: 160 },
];
```

- [ ] **Step 2: Add the client-side types**

Append to `apps/shopify/src/types.ts`:

```ts
export interface ShopifyWidgetTheme {
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

export interface ShopifyWidgetConfigResponse {
  widget: ShopifyWidgetConfig;
  synced: boolean;
}
```

and add `widget?: ShopifyWidgetConfig;` to the existing `ShopifyStoreSettings`
interface in the same file, so `/v1/shopify/me` carries the saved config.

- [ ] **Step 3: Add sample images**

Place two JPEGs in `apps/shopify/src/assets/`:

- `sample-photo.jpg` — a stock photo of a person, portrait, roughly 400×533.
- `sample-result.jpg` — any stock apparel-on-model photo, same aspect.

Neither is a real try-on. Both are captioned "Sample" in the preview so no
merchant reads them as their own data.

- [ ] **Step 4: Build the preview component**

Create `apps/shopify/src/components/WidgetPreview.tsx`:

```tsx
// The real storefront stylesheet, imported straight from the theme extension.
// Sharing the actual CSS is what makes this preview pixel-accurate — only the
// markup below is a mirror, and src/__tests__/widget-drift.test.ts fails if it
// uses a class the Liquid does not have.
//
// If the Vite dev server refuses to serve this path, add
// `server: { fs: { allow: ['..', '../..'] } }` to apps/shopify/vite.config.ts.
import '../../../shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css';

import samplePhoto from '../assets/sample-photo.jpg';
import sampleResult from '../assets/sample-result.jpg';
import { WIDGET_BEHAVIOR_DEFAULTS, WIDGET_COPY_DEFAULTS } from '../lib/widgetDefaults';
import type { ShopifyWidgetConfig } from '../types';

export type PreviewStep = 'upload' | 'ready' | 'generating' | 'result' | 'error';

export function WidgetPreview({
  config,
  step,
}: {
  config: ShopifyWidgetConfig;
  step: PreviewStep;
}) {
  const copy = config.copy ?? {};
  const behavior = config.behavior ?? {};
  const text = (key: keyof typeof WIDGET_COPY_DEFAULTS) =>
    copy[key]?.trim() || WIDGET_COPY_DEFAULTS[key];

  // Only .tryme-tryon__modal-content and inward. The .tryme-tryon__modal
  // wrapper is position:fixed and would escape the page.
  return (
    <div
      className="tryme-tryon__modal-content"
      style={
        {
          '--tryme-accent': config.theme?.accentColor ?? undefined,
          margin: '0 auto',
        } as React.CSSProperties
      }
    >
      <div className="tryme-tryon__modal-inner">
        <div className="tryme-tryon__header">
          <div className="tryme-tryon__header-main">
            <div>
              <p className="tryme-tryon__heading">{text('heading')}</p>
              <p className="tryme-tryon__subheading">{text('subheading')}</p>
            </div>
          </div>
        </div>

        {step === 'upload' && (
          <div className="tryme-tryon__step tryme-tryon__step--upload">
            <div className="tryme-tryon__step-indicator">
              <span className="tryme-tryon__step-dot is-active">1</span>
              <span className="tryme-tryon__step-line" />
              <span className="tryme-tryon__step-dot">2</span>
            </div>
            <h2 className="tryme-tryon__upload-title">{text('uploadTitle')}</h2>
            <p className="tryme-tryon__upload-lead">{text('uploadLead')}</p>
            <div className="tryme-tryon__avatar" />
            <div className="tryme-tryon__button-stack">
              <span className="tryme-tryon__choose-btn">
                <strong>{text('chooseLabel')}</strong>
              </span>
            </div>
            <p className="tryme-tryon__legal">
              {text('legalText')}
              <br />
              AI can make mistakes.
            </p>
          </div>
        )}

        {step === 'ready' && (
          <div className="tryme-tryon__step tryme-tryon__step--ready">
            <div className="tryme-tryon__ready-preview">
              <img className="tryme-tryon__ready-image" src={samplePhoto} alt="Sample" />
              <span className="tryme-tryon__change-photo">Change Photo</span>
            </div>
            <span className="tryme-tryon__cta">
              <span>{text('ctaLabel')}</span>
            </span>
            <p className="tryme-tryon__legal">
              {text('legalText')}
              <br />
              AI can make mistakes.
            </p>
          </div>
        )}

        {step === 'generating' && (
          <div className="tryme-tryon__step tryme-tryon__step--progress">
            <div className="tryme-tryon__progress-canvas">
              <p>{text('generatingText')}</p>
              <div className="tryme-tryon__progress-bar-track">
                {/* Frozen mid-fill so the bar is actually visible in a still preview. */}
                <div className="tryme-tryon__progress-bar-fill" style={{ width: '60%' }} />
              </div>
            </div>
          </div>
        )}

        {step === 'result' && (
          <div className="tryme-tryon__step tryme-tryon__step--result">
            <img className="tryme-tryon__result-image" src={sampleResult} alt="Sample" />
            <div className="tryme-tryon__result-actions">
              {behavior.addToCart !== false && (
                <span className="tryme-tryon__add-to-cart">
                  {behavior.addToCartLabel?.trim() || WIDGET_BEHAVIOR_DEFAULTS.addToCartLabel}
                </span>
              )}
              {behavior.share !== false && (
                <span
                  className="tryme-tryon__share"
                  aria-label={behavior.shareLabel?.trim() || WIDGET_BEHAVIOR_DEFAULTS.shareLabel}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="18" cy="5" r="2.2" />
                    <circle cx="6" cy="12" r="2.2" />
                    <circle cx="18" cy="19" r="2.2" />
                    <path d="m8 11 7.8-4.6M8 13l7.8 4.6" />
                  </svg>
                </span>
              )}
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="tryme-tryon__step tryme-tryon__step--error">
            <p>{text('errorText')}</p>
            <span className="tryme-tryon__retry">Try again</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

Interactive elements are `<span>`, not `<button>` — this is a still preview and
a real button would invite clicks that do nothing.

- [ ] **Step 5: Build the page**

Create `apps/shopify/src/pages/WidgetDesignPage.tsx`:

```tsx
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  Page,
  Tabs,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { WidgetPreview, type PreviewStep } from '../components/WidgetPreview';
import { apiFetch } from '../lib/api';
import {
  WIDGET_BEHAVIOR_DEFAULTS,
  WIDGET_COPY_DEFAULTS,
  WIDGET_COPY_FIELDS,
  type WidgetCopyField,
} from '../lib/widgetDefaults';
import type { ShopifyMe, ShopifyWidgetConfig, ShopifyWidgetConfigResponse } from '../types';

const PREVIEW_TABS: { id: PreviewStep; content: string }[] = [
  { id: 'upload', content: 'Upload' },
  { id: 'ready', content: 'Ready' },
  { id: 'generating', content: 'Generating' },
  { id: 'result', content: 'Result' },
  { id: 'error', content: 'Error' },
];

export default function WidgetDesignPage() {
  const [config, setConfig] = useState<ShopifyWidgetConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((me) => setConfig(me.store.settings.widget ?? {}))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const setCopy = useCallback((key: WidgetCopyField, value: string) => {
    setConfig((c) => ({ ...c, copy: { ...c.copy, [key]: value } }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<ShopifyWidgetConfigResponse>('/v1/shopify/widget-config', {
        method: 'PATCH',
        body: JSON.stringify(config),
      });
      setConfig(res.widget);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [config]);

  const accent = config.theme?.accentColor ?? '';

  return (
    <Page title="Widget Design">
      <Layout>
        <Layout.Section variant="oneHalf">
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Theme
                </Text>
                <InlineStack gap="300" blockAlign="center">
                  <input
                    type="color"
                    aria-label="Accent color"
                    value={accent || '#000000'}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, theme: { accentColor: e.target.value } }))
                    }
                  />
                  <Box width="140px">
                    <TextField
                      label="Accent color"
                      labelHidden
                      autoComplete="off"
                      placeholder="#000000"
                      value={accent}
                      onChange={(v) =>
                        setConfig((c) => ({ ...c, theme: { accentColor: v || null } }))
                      }
                    />
                  </Box>
                  <Button
                    onClick={() => setConfig((c) => ({ ...c, theme: { accentColor: null } }))}
                  >
                    Use button color
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Applies to the modal only. Your storefront button keeps the colors set in the
                  theme editor.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Copy
                </Text>
                {WIDGET_COPY_FIELDS.map((f) => (
                  <TextField
                    key={f.key}
                    label={f.label}
                    autoComplete="off"
                    maxLength={f.max}
                    showCharacterCount
                    placeholder={WIDGET_COPY_DEFAULTS[f.key]}
                    value={config.copy?.[f.key] ?? ''}
                    onChange={(v) => setCopy(f.key, v)}
                  />
                ))}
                <Text as="p" tone="subdued">
                  Leave a field empty to use the default shown in grey.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Behavior
                </Text>
                <Checkbox
                  label="Show Add to Cart on the result"
                  checked={config.behavior?.addToCart !== false}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, behavior: { ...c.behavior, addToCart: v } }))
                  }
                />
                <TextField
                  label="Add to Cart label"
                  autoComplete="off"
                  maxLength={30}
                  disabled={config.behavior?.addToCart === false}
                  placeholder={WIDGET_BEHAVIOR_DEFAULTS.addToCartLabel}
                  value={config.behavior?.addToCartLabel ?? ''}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, behavior: { ...c.behavior, addToCartLabel: v } }))
                  }
                />
                <Checkbox
                  label="Show Share on the result"
                  checked={config.behavior?.share !== false}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, behavior: { ...c.behavior, share: v } }))
                  }
                />
                <TextField
                  label="Share label"
                  autoComplete="off"
                  maxLength={30}
                  disabled={config.behavior?.share === false}
                  placeholder={WIDGET_BEHAVIOR_DEFAULTS.shareLabel}
                  value={config.behavior?.shareLabel ?? ''}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, behavior: { ...c.behavior, shareLabel: v } }))
                  }
                />
              </BlockStack>
            </Card>

            <Button variant="primary" loading={saving} disabled={loading} onClick={save}>
              Save
            </Button>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <div className="widget-preview-sticky">
            <Card padding="0">
              <Tabs
                tabs={PREVIEW_TABS.map((t) => ({ id: t.id, content: t.content }))}
                selected={tab}
                onSelect={setTab}
              />
              <Box padding="400">
                <WidgetPreview config={config} step={PREVIEW_TABS[tab].id} />
              </Box>
            </Card>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 6: Add the sticky style**

The SPA has no global stylesheet — `main.tsx` imports none, and `App.tsx` pulls
in Polaris's own. So create `apps/shopify/src/components/widgetPreview.css`:

```css
.widget-preview-sticky {
  position: sticky;
  top: var(--p-space-400, 16px);
}

@media (max-width: 768px) {
  .widget-preview-sticky {
    position: static;
  }
}
```

and import it at the top of `apps/shopify/src/pages/WidgetDesignPage.tsx`:

```tsx
import '../components/widgetPreview.css';
```

- [ ] **Step 7: Register the route and nav entry**

In `apps/shopify/src/App.tsx`, add the import:

```tsx
import WidgetDesignPage from './pages/WidgetDesignPage';
```

and the route, between `/manage` and `/support`:

```tsx
          <Route path="/manage" element={<ManagePage />} />
          <Route path="/widget-design" element={<WidgetDesignPage />} />
          <Route path="/support" element={<SupportPage />} />
```

In `apps/shopify/src/components/AppNavMenu.tsx`, add `PaintBrushFlatIcon` to
the icon import and a nav entry after Manage:

```tsx
import {
  HomeIcon,
  PaintBrushFlatIcon,
  ProductIcon,
  QuestionCircleIcon,
} from '@shopify/polaris-icons';

export const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: HomeIcon },
  { path: '/manage', label: 'Manage', icon: ProductIcon },
  { path: '/widget-design', label: 'Widget Design', icon: PaintBrushFlatIcon },
  { path: '/support', label: 'Support', icon: QuestionCircleIcon },
];
```

If shopper-limits Task 7 has already added a Settings entry, place Widget Design
**before** it.

- [ ] **Step 8: Verify the page renders**

Run: `pnpm --filter @tryme/shopify-admin dev`

Open `http://localhost:5174/widget-design`. Confirm:

1. The page loads with the form on the left, preview on the right.
2. Typing in "Modal heading" changes the preview header immediately.
3. Changing the color input recolors the preview's choose-photo button.
4. Each of the five tabs renders its step.
5. Unchecking "Show Share" removes the share button from the Result tab.
6. Narrowing the window below 768px stacks the preview beneath the form.

If the dev server errors on the `tryon-widget.css` import, add to
`apps/shopify/vite.config.ts` inside `server`:

```ts
    fs: { allow: ['..', '../..'] },
```

- [ ] **Step 9: Typecheck and build**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm --filter @tryme/shopify-admin build`
Expected: clean. The build step matters — it proves the cross-package CSS import
resolves in Rollup, not just in the dev server.

- [ ] **Step 10: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify): widget design page with live modal preview"
```

---

## Task 7: Vitest for the SPA and the two drift guards

**Files:**
- Modify: `apps/shopify/package.json`
- Create: `apps/shopify/vitest.config.ts`
- Create: `apps/shopify/src/__tests__/widget-drift.test.ts`

**Interfaces:**
- Consumes: `WIDGET_COPY_DEFAULTS` and `WIDGET_BEHAVIOR_DEFAULTS` from Task 6; the `| default:` strings and class names in `tryon-button.liquid` from Tasks 3-5; the class names in `WidgetPreview.tsx` from Task 6.
- Produces: `pnpm --filter @tryme/shopify-admin test`.

- [ ] **Step 1: Add the test runner**

In `apps/shopify/package.json`, add to `scripts`:

```json
    "test": "vitest run",
```

and to `devDependencies`:

```json
    "vitest": "^2.1.3",
```

Then: `pnpm install`

- [ ] **Step 2: Add the vitest config**

Create `apps/shopify/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// These tests read source files as text and compare them. No DOM, no React
// rendering — `node` is all they need, and it keeps the run under a second.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `apps/shopify/src/__tests__/widget-drift.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WIDGET_BEHAVIOR_DEFAULTS, WIDGET_COPY_DEFAULTS } from '../lib/widgetDefaults';

const here = dirname(fileURLToPath(import.meta.url));

const liquid = readFileSync(
  resolve(
    here,
    '../../../shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid',
  ),
  'utf8',
);
const preview = readFileSync(resolve(here, '../components/WidgetPreview.tsx'), 'utf8');

function widgetClasses(source: string): Set<string> {
  return new Set(source.match(/tryme-tryon__[a-z0-9-]+/g) ?? []);
}

describe('WidgetPreview mirrors the Liquid markup', () => {
  it('uses only classes that exist in tryon-button.liquid', () => {
    const inLiquid = widgetClasses(liquid);
    const missing = [...widgetClasses(preview)].filter((c) => !inLiquid.has(c));
    // A one-directional check on purpose: adding a class to the Liquid is fine
    // (the preview does not show every state), but a class the preview uses and
    // the Liquid does not means the preview has drifted or the Liquid renamed
    // something out from under it.
    expect(missing).toEqual([]);
  });
});

describe('default copy matches the Liquid fallbacks', () => {
  const liquidDefaults = new Set(
    [...liquid.matchAll(/\|\s*default:\s*'([^']*)'/g)].map((m) => m[1]),
  );

  it.each(Object.entries(WIDGET_COPY_DEFAULTS))(
    'copy default %s is the Liquid fallback',
    (_key, value) => {
      expect([...liquidDefaults]).toContain(value);
    },
  );

  it.each(Object.entries(WIDGET_BEHAVIOR_DEFAULTS))(
    'behavior default %s is the Liquid fallback',
    (_key, value) => {
      expect([...liquidDefaults]).toContain(value);
    },
  );

  it('no default contains a single quote, which the Liquid parser cannot express', () => {
    const all = [
      ...Object.values(WIDGET_COPY_DEFAULTS),
      ...Object.values(WIDGET_BEHAVIOR_DEFAULTS),
    ];
    expect(all.filter((v) => v.includes("'"))).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tryme/shopify-admin test`
Expected: PASS. If the defaults tests fail, the `| default:` string in
`tryon-button.liquid` and the value in `widgetDefaults.ts` disagree — fix the
mismatch rather than loosening the assertion.

- [ ] **Step 5: Prove the guard actually guards**

Temporarily change `WIDGET_COPY_DEFAULTS.heading` to `'Try It Onn'` and re-run.
Expected: FAIL on `copy default heading is the Liquid fallback`. Revert.

Temporarily add `className="tryme-tryon__nonexistent"` to a `<div>` in
`WidgetPreview.tsx` and re-run. Expected: FAIL with that class in `missing`.
Revert.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/package.json apps/shopify/vitest.config.ts \
        apps/shopify/src/__tests__/widget-drift.test.ts pnpm-lock.yaml
git commit -m "test(shopify): guard widget preview against liquid drift"
```

---

## Task 8: Save bar, unsaved-changes guard, and sync warning

**Files:**
- Create: `apps/shopify/src/lib/navGuard.ts`
- Modify: `apps/shopify/src/lib/appBridge.ts`
- Modify: `apps/shopify/src/pages/WidgetDesignPage.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppNavMenu.tsx`

**Interfaces:**
- Consumes: `WidgetDesignPage`'s `config`/`save` state from Task 6; `POST /v1/shopify/widget-config/republish` from Task 2.
- Produces: `setNavGuard(fn: (() => boolean) | null): void` and `runNavGuard(): boolean` from `./lib/navGuard`.

> **Why not `useBlocker`:** `apps/shopify/src/main.tsx` mounts `<BrowserRouter>`.
> `useBlocker` requires a data router (`createBrowserRouter`) and throws
> otherwise. Converting the app's routing to a data router is a much larger
> change than this feature warrants, so the two in-app navigation call sites
> consult a guard function instead.

- [ ] **Step 1: Add the nav guard module**

Create `apps/shopify/src/lib/navGuard.ts`:

```ts
/**
 * Unsaved-changes guard for in-app navigation.
 *
 * react-router's useBlocker needs a data router; main.tsx mounts a plain
 * <BrowserRouter>. Both places that navigate programmatically (App.tsx's dev
 * Navigation and AppNavMenu's <ui-nav-menu> links) call runNavGuard() first and
 * abandon the navigation if it returns false.
 *
 * Only one guard can be registered at a time — only one page has a form.
 */
let guard: (() => boolean) | null = null;

export function setNavGuard(fn: (() => boolean) | null): void {
  guard = fn;
}

/** @returns true when navigation may proceed. */
export function runNavGuard(): boolean {
  return guard ? guard() : true;
}
```

- [ ] **Step 2: Declare the App Bridge save bar**

In `apps/shopify/src/lib/appBridge.ts`, extend the `Window` interface:

```ts
  interface Window {
    shopify?: {
      idToken(): Promise<string>;
      saveBar?: {
        show(id: string): Promise<void>;
        hide(id: string): Promise<void>;
      };
    };
  }
```

and add `ui-save-bar` next to the existing `ui-nav-menu` declaration:

```ts
      interface IntrinsicElements {
        'ui-nav-menu': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
        'ui-save-bar': React.DetailedHTMLProps<
          React.HTMLAttributes<HTMLElement> & { id: string },
          HTMLElement
        >;
      }
```

- [ ] **Step 3: Wire the guard into both nav call sites**

In `apps/shopify/src/App.tsx`, inside the `devNavigation` items map, change the
click handler:

```tsx
          onClick: () => {
            if (runNavGuard()) navigate(item.path);
          },
```

and add the import:

```tsx
import { runNavGuard } from './lib/navGuard';
```

In `apps/shopify/src/components/AppNavMenu.tsx`, change the anchor handler:

```tsx
          onClick={(e) => {
            // Let Shopify keep the admin URL in sync, but do the actual route
            // change in-app — a real navigation would reload the iframe and
            // re-run the App Bridge handshake on every nav click.
            e.preventDefault();
            if (runNavGuard()) navigate(item.path);
          }}
```

and add the import:

```tsx
import { runNavGuard } from '../lib/navGuard';
```

- [ ] **Step 4: Add dirty tracking, the save bar, and the sync banner**

In `apps/shopify/src/pages/WidgetDesignPage.tsx`, add these imports:

```tsx
import { ContextualSaveBar, Modal } from '@shopify/polaris';
import { useMemo, useRef } from 'react';
import { setNavGuard } from '../lib/navGuard';
```

Replace the state block and `save` callback with:

```tsx
  const [config, setConfig] = useState<ShopifyWidgetConfig>({});
  const [saved, setSaved] = useState<ShopifyWidgetConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(true);
  const [republishing, setRepublishing] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((me) => {
        const w = me.store.settings.widget ?? {};
        setConfig(w);
        setSaved(w);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Structural compare, not reference: editing a field and undoing the edit
  // must clear the save bar rather than leave it stuck open.
  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(saved),
    [config, saved],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<ShopifyWidgetConfigResponse>('/v1/shopify/widget-config', {
        method: 'PATCH',
        body: JSON.stringify(config),
      });
      setConfig(res.widget);
      setSaved(res.widget);
      setSynced(res.synced);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [config]);

  const discard = useCallback(() => setConfig(saved), [saved]);

  const republish = useCallback(async () => {
    setRepublishing(true);
    try {
      const res = await apiFetch<{ synced: boolean }>(
        '/v1/shopify/widget-config/republish',
        { method: 'POST' },
      );
      setSynced(res.synced);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRepublishing(false);
    }
  }, []);
```

Add these two effects below:

```tsx
  // Register the guard while this page is mounted. Returning false abandons the
  // navigation outright and opens the modal — the merchant re-clicks the nav
  // item after deciding. Deliberately not queuing and replaying the pending
  // navigation: the guard is called from two different call sites with no
  // shared notion of "the navigation that was attempted", and a stale queued
  // target is worse than a second click.
  //
  // A ref, not `dirty` in the dep array: re-registering the guard on every
  // keystroke would race with a nav click landing between unregister and
  // register.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    setNavGuard(() => {
      if (!dirtyRef.current) return true;
      setBlocked(true);
      return false;
    });
    return () => setNavGuard(null);
  }, []);

  // App Bridge's save bar lives in the admin's own top chrome, outside this
  // iframe, so it is shown imperatively rather than by rendering.
  useEffect(() => {
    const bar = window.shopify?.saveBar;
    if (!bar) return;
    if (dirty) bar.show('widget-design-save').catch(() => {});
    else bar.hide('widget-design-save').catch(() => {});
  }, [dirty]);

  // Covers reload and tab close, which no in-app guard can see.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
```

Delete the plain `<Button variant="primary" … >Save</Button>` added in Task 6 —
the save bar replaces it. Then add, as the first children inside `<Page>`:

```tsx
      {window.shopify ? (
        <ui-save-bar id="widget-design-save">
          <button {...{ variant: 'primary' }} onClick={save} type="button">
            Save
          </button>
          <button onClick={discard} type="button">
            Discard
          </button>
        </ui-save-bar>
      ) : dirty ? (
        <ContextualSaveBar
          message="Unsaved changes"
          saveAction={{ onAction: save, loading: saving }}
          discardAction={{ onAction: discard }}
        />
      ) : null}

      {blocked && (
        <Modal
          open
          title="You have unsaved changes"
          onClose={() => setBlocked(false)}
          primaryAction={{
            content: 'Save',
            onAction: async () => {
              await save();
              setBlocked(false);
            },
            loading: saving,
          }}
          secondaryActions={[
            {
              content: 'Discard',
              onAction: () => {
                discard();
                setBlocked(false);
              },
            },
            { content: 'Keep editing', onAction: () => setBlocked(false) },
          ]}
        >
          <Modal.Section>
            <Text as="p">Your widget changes have not been saved yet.</Text>
          </Modal.Section>
        </Modal>
      )}
```

`{...{ variant: 'primary' }}` rather than `variant="primary"`: App Bridge reads
that attribute off the DOM node, but React's `<button>` typing has no such prop,
and a spread is the least invasive way to set it without widening the global JSX
types.

Finally, add the sync banner above the existing error banner:

```tsx
            {!synced && (
              <Banner
                tone="warning"
                title="Storefront not updated"
                action={{
                  content: 'Retry',
                  onAction: republish,
                  loading: republishing,
                }}
              >
                Your settings were saved, but we could not update your storefront. Shoppers still
                see the previous text.
              </Banner>
            )}
```

- [ ] **Step 5: Verify by hand**

Run: `pnpm --filter @tryme/shopify-admin dev`, open `/widget-design`.

1. Edit a field → the Polaris save bar appears (dev mode has no App Bridge).
2. Undo the edit by hand → the bar disappears. This is the check that dirty
   tracking is structural, not reference-based.
3. Edit a field, click Manage in the nav → the unsaved-changes modal opens and
   the route does **not** change.
4. Choose "Discard" in that modal → the form reverts and the bar clears.
5. Edit and press reload → the browser's own leave-site prompt appears.
6. Save with the API stopped → the critical error banner appears and the bar
   stays.

- [ ] **Step 6: Typecheck, lint, test**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm lint && pnpm --filter @tryme/shopify-admin test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify): save bar, unsaved-changes guard and sync retry"
```

---

## Task 9: Documentation and full verification

**Files:**
- Modify: `docs/progress.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the architecture notes**

In `CLAUDE.md`, insert this new section immediately **after** the
"### Adding a GPU worker" section and before "## Web App Architecture
(apps/catalogues-web)":

```markdown
### Shopify theme extension

`apps/shopify-extension/extensions/tryon-theme-extension` ships one **app
block** (`blocks/tryon-button.liquid`, `target: "section"`), which the merchant
drags into their product template. It is not an app embed — an earlier version
was, and it had to relocate itself via guessed CSS selectors, which broke on
every theme switch. App blocks require an Online Store 2.0 (JSON) template;
vintage themes are unsupported.

Modal copy, accent color, and result-step actions come from the
`tryme.widget_config` shop metafield, written by
`PATCH /v1/shopify/widget-config` and edited on the app's Widget Design page.
Postgres (`shopify_stores.settings.widget`) is authoritative; the metafield is a
cache, and a failed mirror surfaces as `synced: false`.
```

- [ ] **Step 2: Add a progress entry**

Add a new dated entry at the **top** of `docs/progress.md`:

```markdown
## 2026-07-31 — Shopify Widget Design + app block migration

**Done**
- Try-on button moved from app embed (`target: "body"`) to app block
  (`target: "section"`, `enabled_on.templates: ["product"]`). Deleted
  `tryon-block.liquid`, `FALLBACK_PLACEMENT_SELECTORS`, `placeWidget()` (~48
  lines), and the `placement_selector` / `block_alignment` settings. Theme-editor
  deep link switched from `activateAppId` to
  `template=product&addAppBlockId=…&target=mainSection`.
- Widget config stored in `shopify_stores.settings.widget` (no migration) and
  mirrored to the `tryme.widget_config` shop metafield via the GraphQL
  `metafieldsSet` mutation — REST `POST /metafields.json` cannot upsert.
- `PATCH /v1/shopify/widget-config` and
  `POST /v1/shopify/widget-config/republish`. Postgres authoritative; failed
  mirror returns `synced: false` on a 200.
- Nine configurable copy fields, accent color, and Add to Cart / Share on the
  result step. Add to Cart reads the theme product form's selected variant and
  shows Shopify's own 422 message on refusal.
- Widget Design page: Polaris two-half layout, live preview built on the real
  `tryon-widget.css`, five step tabs, App Bridge `ui-save-bar` (Polaris
  `ContextualSaveBar` in dev), unsaved-changes guard, sync-failure retry banner.
- vitest added to `apps/shopify` with two drift guards binding the preview and
  its default copy to `tryon-button.liquid`.

**Failed / Not Done**
- Vintage (non-OS-2.0) theme support dropped by decision — app blocks require
  JSON templates. Acceptable at zero installs; revisiting means reintroducing a
  second render path.
- "Show remaining try-ons" deferred: needs a shopper-limits read endpoint that
  returns remaining quota before generation.
- Result-step cart and share logic has no automated test — the theme extension
  has no test runner. Verified on a dev store per the plan's manual checklists.

**Open Questions / Decisions**
- `useBlocker` was unusable (app mounts `<BrowserRouter>`, not a data router), so
  a module-level `navGuard` consulted by both nav call sites replaced it. If the
  app ever moves to `createBrowserRouter`, that module should go away.
- `WIDGET_COPY_DEFAULTS` lives in `apps/shopify/src/lib/widgetDefaults.ts` rather
  than `packages/types`, because `apps/shopify` deliberately has no
  `@tryme/types` dependency (keeps zod out of the SPA bundle) and the server
  never needs the defaults.
```

- [ ] **Step 3: Run the full verification**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @tryme/shopify-admin test
pnpm --filter @tryme/api test -- metafields
pnpm --filter @tryme/api test -- onboarding
pnpm --filter @tryme/api test -- shopify-widget-config
pnpm --filter @tryme/shopify-admin build
```

Run the three API test files individually, **not** the whole integration suite.
The suite has a known pre-existing Redis rate-limiter 429 cascade when every
file runs together; that is unrelated to this work and running it here would
produce noise, not signal.

- [ ] **Step 4: Commit**

```bash
git add docs/progress.md CLAUDE.md
git commit -m "docs(shopify): record widget design and app block migration"
```

---

## Verification Checklist

- [ ] `pnpm typecheck` and `pnpm lint` clean across the workspace.
- [ ] `apps/shopify` vitest passes, and both drift guards were proven to fail when deliberately broken (Task 7 Step 5).
- [ ] `metafields`, `onboarding`, and `shopify-widget-config` API tests pass.
- [ ] `pnpm --filter @tryme/shopify-admin build` succeeds — proves the cross-package CSS import resolves in Rollup, not only in the dev server.
- [ ] `tryon-block.liquid` is gone; `grep -rn "placeWidget\|placement_selector\|blockAlignment" apps/shopify-extension` returns nothing.
- [ ] If shopper-limits Task 6 had landed first, the email-gate markup is present in `tryon-button.liquid`.
- [ ] Dev store: the deep link opens the product template with the block staged; placing it renders the button where dropped.
- [ ] Dev store: with no `widget_config` metafield, the widget looks exactly as it did before this work.
- [ ] Dev store: a merchant copy value of `<b>x</b>` renders as literal text, not markup.
- [ ] Dev store: Add to Cart adds the shopper's **selected** variant; a sold-out variant shows Shopify's message and re-enables the button.
