# Try On Library Mobile-Native Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/tryon-library-app` from scratch as a mobile-native, premium-feeling UI (real full-screen routes with a native back-button, image-forward grids, a FAB) reusing 100% of the existing backend APIs — plus fix a real security gap found along the way (Google OAuth login can currently bypass the mini-app's merchant-only restriction).

**Architecture:** Real Next.js nested routes under `apps/catalogues-web/src/app/tryon-library-app/` (not component-state view-switching) so the browser/PWA back button works natively. The session gate (silent refresh / login form) moves from `page.tsx` up into `layout.tsx` so every nested route is protected uniformly. All five desktop-derived UI files (`LibraryContent.tsx`, `LibraryTopBar.tsx`, `SubcategoryModal.tsx`, `ProductModal.tsx`, `BulkUploadModal.tsx`) are deleted and replaced with small, focused, mobile-first components.

**Tech Stack:** Next.js 15 App Router, React, TanStack Query, existing `@tryme/types` Zod schemas, existing design tokens (`C`, `grad` from `@/components/tokens`), Fastify 5 (one small backend fix), Vitest integration tests (backend only — this codebase has no frontend component test framework).

---

## Spec reference

`docs/superpowers/specs/2026-07-28-tryon-library-mobile-rebuild-design.md`

## Amendment to the spec (found during planning, not in the original doc)

While gathering file context for this plan, two files were found already modified **uncommitted** in the working tree: `apps/catalogues-web/src/app/tryon-library-app/page.tsx` (added a "Continue with Google" button) and `apps/api/src/modules/auth/google.routes.ts` (the `/v1/auth/google/exchange` route already accepts an optional `portal` field). Tracing the whole OAuth round-trip found it is **not** gated by merchant status the way `/v1/auth/login` is for `portal: 'catalog-app'` — any Google account, merchant or not, would currently receive a valid `catalog-app`-audience session. Task 1 and Task 2 below fix this (confirmed with the user this should be properly supported, not dropped).

---

### Task 1: Merchant-only gate on Google OAuth exchange for the catalog-app portal

**Files:**
- Modify: `apps/api/src/modules/auth/google.routes.ts`
- Test: `apps/api/test/integration/catalog-app-google-exchange.test.ts` (new)

The `/v1/auth/login` route already gates `portal: 'catalog-app'` logins to merchant accounts only (look up `schema.merchants` by `userId`, 403 if none/inactive). The Google exchange route (`/v1/auth/google/exchange`, uncommitted change already added a `portal` field) currently skips this check entirely.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/integration/catalog-app-google-exchange.test.ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('catalog-app portal — Google OAuth exchange', () => {
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

  it('rejects a non-merchant account exchanging an OTP with portal: catalog-app', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `notmerchant-google-${Date.now()}@example.com`,
        passwordHash: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    const otp = 'test-otp-non-merchant';
    await app.redis.set(`oauth:otp:${otp}`, user?.id ?? '', 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp, portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a merchant account exchanging an OTP with portal: catalog-app, issuing a catalog-app-audience session', async () => {
    const { userId } = await createTestMerchant(app);
    const otp = 'test-otp-merchant';
    await app.redis.set(`oauth:otp:${otp}`, userId, 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp, portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((ck) => ck.name);
    expect(cookies).toContain('catalog_app_refresh');
    expect(cookies).not.toContain('refresh');

    const { accessToken } = res.json() as { accessToken: string };
    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('plain portal: web exchange is unaffected by the merchant check', async () => {
    const passwordHash = null;
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `plain-google-${Date.now()}@example.com`,
        passwordHash,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    const otp = 'test-otp-plain-web';
    await app.redis.set(`oauth:otp:${otp}`, user?.id ?? '', 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((ck) => ck.name);
    expect(cookies).toContain('refresh');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/api/`): `npx vitest run --config vitest.integration.config.ts test/integration/catalog-app-google-exchange.test.ts`
Expected: FAIL — the first test expects 403 but gets 200 (no merchant gate exists yet).

- [ ] **Step 3: Implement the merchant gate**

In `apps/api/src/modules/auth/google.routes.ts`, the exchange route currently reads (already present, uncommitted):

```ts
  app.post(
    '/v1/auth/google/exchange',
    {
      schema: { body: z.object({ code: z.string().min(1), portal: z.enum(['web', 'catalog-app']).optional() }) },
    },
    async (req, reply) => {
      const { code, portal } = req.body as { code: string; portal?: 'web' | 'catalog-app' };
      const userId = await app.redis.getdel(`oauth:otp:${code}`);
      if (!userId) throw new AppError('INVALID_OTP', 400, 'invalid or expired OTP');
      return createSessionTokens(app, userId, reply, 200, portal ?? 'web');
    },
  );
```

Replace it with:

```ts
  app.post(
    '/v1/auth/google/exchange',
    {
      schema: { body: z.object({ code: z.string().min(1), portal: z.enum(['web', 'catalog-app']).optional() }) },
    },
    async (req, reply) => {
      const { code, portal } = req.body as { code: string; portal?: 'web' | 'catalog-app' };
      const userId = await app.redis.getdel(`oauth:otp:${code}`);
      if (!userId) throw new AppError('INVALID_OTP', 400, 'invalid or expired OTP');
      if (portal === 'catalog-app') {
        const [merchant] = await app.db
          .select({ id: schema.merchants.id, isActive: schema.merchants.isActive })
          .from(schema.merchants)
          .where(eq(schema.merchants.userId, userId))
          .limit(1);
        if (!merchant || !merchant.isActive) {
          throw new AppError('NOT_A_MERCHANT', 403, 'not a merchant account');
        }
      }
      return createSessionTokens(app, userId, reply, 200, portal ?? 'web');
    },
  );
```

`schema` and `eq` are already imported at the top of this file (`import { schema } from '@tryme/db';` and `import { and, eq, sql } from 'drizzle-orm';`) — no new imports needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/catalog-app-google-exchange.test.ts`
Expected: PASS, 3/3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/auth/google.routes.ts apps/api/test/integration/catalog-app-google-exchange.test.ts
git commit -m "fix(api): gate catalog-app Google OAuth exchange to merchant accounts only"
```

---

### Task 2: Portal-aware error redirect in the Google OAuth BFF callback

**Files:**
- Modify: `apps/catalogues-web/src/app/api/auth/google/callback/route.ts`

Today this route (uncommitted change already present) always redirects failures to `${BASE_PATH}/login?error=oauth_failed` — wrong for the mini-app: a merchant-gate rejection or any other failure during a catalog-app OAuth attempt should land back on `/tryon-library-app`, not the main site's login page, and should distinguish "not a merchant" from a generic failure so the mini-app can show a clear message.

- [ ] **Step 1: Read the current file**

Current content (already has the `portal` detection from the prior uncommitted change):

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function getWebOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (proto && host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

export async function GET(req: NextRequest) {
  const webOrigin = getWebOrigin(req);
  const code = req.nextUrl.searchParams.get('code');
  const next = req.nextUrl.searchParams.get('next');

  if (!code) {
    const url = new URL(`${BASE_PATH}/login`, webOrigin);
    url.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(url);
  }

  let data: { accessToken?: string };
  let setCookieHeader: string | null = null;
  let portal: 'web' | 'catalog-app' = 'web';
  if (next?.startsWith('/tryon-library-app')) {
    portal = 'catalog-app';
  }

  try {
    const res = await fetch(`${API_URL}/v1/auth/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, portal }),
    });

    if (!res.ok) {
      const url = new URL(`${BASE_PATH}/login`, webOrigin);
      url.searchParams.set('error', 'oauth_failed');
      return NextResponse.redirect(url);
    }

    data = (await res.json()) as { accessToken?: string };
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    setCookieHeader = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
  } catch {
    const url = new URL(`${BASE_PATH}/login`, webOrigin);
    url.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(url);
  }

  if (!data.accessToken) {
    const url = new URL(`${BASE_PATH}/login`, webOrigin);
    url.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(url);
  }

  const target = next ? `${BASE_PATH}${next}` : `${BASE_PATH}/studio`;
  const response = NextResponse.redirect(new URL(target, webOrigin));
  if (portal === 'catalog-app') {
    setCatalogAppCookies(response, setCookieHeader);
  } else {
    setAuthCookies(response, data.accessToken, setCookieHeader);
  }
  return response;
}
```

- [ ] **Step 2: Replace with the portal-aware version**

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function getWebOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (proto && host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

export async function GET(req: NextRequest) {
  const webOrigin = getWebOrigin(req);
  const code = req.nextUrl.searchParams.get('code');
  const next = req.nextUrl.searchParams.get('next');
  const portal: 'web' | 'catalog-app' = next?.startsWith('/tryon-library-app')
    ? 'catalog-app'
    : 'web';
  const errorBase = portal === 'catalog-app' ? '/tryon-library-app' : '/login';

  function oauthFailedRedirect(reason: string): NextResponse {
    const url = new URL(`${BASE_PATH}${errorBase}`, webOrigin);
    url.searchParams.set('error', reason);
    return NextResponse.redirect(url);
  }

  if (!code) return oauthFailedRedirect('oauth_failed');

  let data: { accessToken?: string };
  let setCookieHeader: string | null = null;

  try {
    const res = await fetch(`${API_URL}/v1/auth/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, portal }),
    });

    if (!res.ok) {
      let reason = 'oauth_failed';
      try {
        const body = (await res.json()) as { error?: { code?: string } };
        if (body.error?.code === 'NOT_A_MERCHANT') reason = 'not_a_merchant';
      } catch {
        // response wasn't JSON — keep the generic reason
      }
      return oauthFailedRedirect(reason);
    }

    data = (await res.json()) as { accessToken?: string };
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    setCookieHeader = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
  } catch {
    return oauthFailedRedirect('oauth_failed');
  }

  if (!data.accessToken) return oauthFailedRedirect('oauth_failed');

  const target = next ? `${BASE_PATH}${next}` : `${BASE_PATH}/studio`;
  const response = NextResponse.redirect(new URL(target, webOrigin));
  if (portal === 'catalog-app') {
    setCatalogAppCookies(response, setCookieHeader);
  } else {
    setAuthCookies(response, data.accessToken, setCookieHeader);
  }
  return response;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/api/auth/google/callback/route.ts
git commit -m "fix(web): redirect catalog-app OAuth failures back to the mini-app, not /login"
```

---

### Task 3: Delete the desktop-derived UI files

**Files:**
- Delete: `apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx`
- Delete: `apps/catalogues-web/src/app/tryon-library-app/LibraryTopBar.tsx`
- Delete: `apps/catalogues-web/src/app/tryon-library-app/SubcategoryModal.tsx`
- Delete: `apps/catalogues-web/src/app/tryon-library-app/ProductModal.tsx`
- Delete: `apps/catalogues-web/src/app/tryon-library-app/BulkUploadModal.tsx`

These are being fully replaced by Tasks 4–14. `page.tsx` will be rewritten in Task 7 (as `layout.tsx` + a new `page.tsx`) so it's fine that it still imports these until then — do this deletion first so later tasks aren't tempted to patch the old files.

- [ ] **Step 1: Delete the files**

```bash
git rm apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx
git rm apps/catalogues-web/src/app/tryon-library-app/LibraryTopBar.tsx
git rm apps/catalogues-web/src/app/tryon-library-app/SubcategoryModal.tsx
git rm apps/catalogues-web/src/app/tryon-library-app/ProductModal.tsx
git rm apps/catalogues-web/src/app/tryon-library-app/BulkUploadModal.tsx
```

- [ ] **Step 2: Commit**

(`page.tsx` still imports the now-deleted `LibraryContent` at this point — typecheck will fail until Task 7. That's expected and fine for one intermediate commit in this rebuild; don't run typecheck as a gate here.)

```bash
git commit -m "chore(web): remove desktop-derived Try On Library mini-app UI (being rebuilt mobile-first)"
```

---

### Task 4: Shared layout primitives — ScreenHeader, StickyBottomBar, Fab

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/ScreenHeader.tsx`
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/StickyBottomBar.tsx`
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/Fab.tsx`

`ScreenHeader` has two variants: `root` (title + credits chip + avatar/logout — only ever used on the Subcategories screen) and `back` (back-arrow + title/subtitle — every nested screen). Both use `env(safe-area-inset-top)` padding for PWA notch-safety, matching the spec's safe-area requirement.

- [ ] **Step 1: Create `ScreenHeader.tsx`**

```tsx
'use client';
import { ArrowLeft } from '@/components/icons';
import { C } from '@/components/tokens';
import { LibraryUserMenu } from '../LibraryUserMenu';

type ScreenHeaderProps =
  | { variant: 'root'; title: string; onLoggedOut: () => void }
  | { variant: 'back'; title: string; subtitle?: string; onBack: () => void };

export function ScreenHeader(props: ScreenHeaderProps) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: C.white,
        borderBottom: `1px solid ${C.border}`,
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      <div
        style={{
          height: 56,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {props.variant === 'back' && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back"
            className="focus-ring hover-surface"
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 10,
              border: 'none',
              background: 'transparent',
              color: C.text,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft />
          </button>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: C.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {props.title}
          </div>
          {props.variant === 'back' && props.subtitle && (
            <div
              style={{
                fontSize: 12,
                color: C.mid,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {props.subtitle}
            </div>
          )}
        </div>

        {props.variant === 'root' && <LibraryUserMenu onLoggedOut={props.onLoggedOut} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `StickyBottomBar.tsx`**

```tsx
'use client';
import { C } from '@/components/tokens';

export function StickyBottomBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        background: C.white,
        borderTop: `1px solid ${C.border}`,
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
        display: 'flex',
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Create `Fab.tsx`**

```tsx
'use client';
import { PlusIcon } from '@/components/icons';
import { grad } from '@/components/tokens';

export function Fab({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="focus-ring"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
        width: 56,
        height: 56,
        borderRadius: '50%',
        border: 'none',
        background: grad,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 8px 20px rgba(0,0,0,0.25)',
        cursor: 'pointer',
        zIndex: 20,
      }}
    >
      <PlusIcon size={22} />
    </button>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: errors about `LibraryUserMenu` import from `'../LibraryUserMenu'` are fine (file exists, unchanged) — no errors from these three new files themselves. (The overall build will still fail until `page.tsx`/`layout.tsx` are rewritten in Task 7 — that's expected at this point in the plan.)

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/components/ScreenHeader.tsx apps/catalogues-web/src/app/tryon-library-app/components/StickyBottomBar.tsx apps/catalogues-web/src/app/tryon-library-app/components/Fab.tsx
git commit -m "feat(web): add ScreenHeader/StickyBottomBar/Fab primitives for the mobile Try On Library rebuild"
```

---

### Task 5: CategoryTabs component

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/CategoryTabs.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client';
import type { MerchantCatalogCategory } from '@tryme/types';
import { C } from '@/components/tokens';

const CATEGORIES: { id: MerchantCatalogCategory; label: string }[] = [
  { id: 'men', label: 'Men' },
  { id: 'women', label: 'Women' },
  { id: 'boys', label: 'Boys' },
  { id: 'girls', label: 'Girls' },
];

export function CategoryTabs({
  selected,
  onSelect,
}: {
  selected: MerchantCatalogCategory;
  onSelect: (category: MerchantCatalogCategory) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '12px 16px' }}>
      {CATEGORIES.map((cat) => {
        const isSelected = cat.id === selected;
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => onSelect(cat.id)}
            className="focus-ring"
            style={{
              flexShrink: 0,
              padding: '8px 16px',
              borderRadius: 20,
              border: `1px solid ${isSelected ? C.pink : C.border2}`,
              background: isSelected ? 'rgba(245, 92, 122, 0.08)' : C.white,
              color: isSelected ? C.pink : C.text,
              fontWeight: isSelected ? 600 : 500,
              fontSize: 14,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
            {cat.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/components/CategoryTabs.tsx
git commit -m "feat(web): add CategoryTabs component for the mobile Try On Library rebuild"
```

---

### Task 6: SubcategoryCard and ProductCard components

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/SubcategoryCard.tsx`
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/ProductCard.tsx`

Image-forward grid cards, 44px-minimum tap targets, matching the "premium" visual rules from the spec (restrained color, 1px borders, no heavy shadows).

- [ ] **Step 1: Create `SubcategoryCard.tsx`**

```tsx
'use client';
import type { MerchantCatalogSubcategory } from '@tryme/types';
import { GarmentIcon, TrashIcon } from '@/components/icons';
import { C } from '@/components/tokens';

export function SubcategoryCard({
  subcategory,
  garmentTypeLabel,
  onOpen,
  onDelete,
}: {
  subcategory: MerchantCatalogSubcategory;
  garmentTypeLabel: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        position: 'relative',
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        background: C.card,
        padding: '20px 16px 16px',
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${subcategory.name}`}
        className="focus-ring hover-surface"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 36,
          height: 36,
          borderRadius: 8,
          border: 'none',
          background: 'transparent',
          color: C.light,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 1,
        }}
      >
        <TrashIcon />
      </button>

      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        className="focus-ring"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          cursor: 'pointer',
          outline: 'none',
          minHeight: 44,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'rgba(245, 92, 122, 0.08)',
            color: C.pink,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <GarmentIcon size={22} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text, wordBreak: 'break-word' }}>
            {subcategory.name}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                background: C.border2,
                color: C.text,
                padding: '2px 8px',
                borderRadius: 6,
                textTransform: 'uppercase',
              }}
            >
              {garmentTypeLabel}
            </span>
            <span style={{ fontSize: 12, color: C.mid }}>
              {subcategory.productCount} {subcategory.productCount === 1 ? 'product' : 'products'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `ProductCard.tsx`**

```tsx
'use client';
import type { MerchantCatalogItem } from '@tryme/types';
import { GarmentIcon, TrashIcon } from '@/components/icons';
import { C } from '@/components/tokens';

export function ProductCard({
  product,
  onOpen,
  onDelete,
}: {
  product: MerchantCatalogItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        background: C.card,
        position: 'relative',
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${product.label}`}
        className="focus-ring hover-surface"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 32,
          height: 32,
          borderRadius: 8,
          background: C.card,
          border: `1px solid ${C.border2}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: C.pink,
          cursor: 'pointer',
          zIndex: 1,
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        <TrashIcon />
      </button>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled below via role=button */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: role=button + onKeyDown makes this accessible */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        className="focus-ring"
        style={{ display: 'flex', flexDirection: 'column', cursor: 'pointer', outline: 'none' }}
      >
        <div
          style={{
            aspectRatio: '3/4',
            background: C.lighter,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {product.thumbnailUrl || product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            // biome-ignore lint/performance/noImgElement: presigned R2 URL
            <img
              src={product.thumbnailUrl ?? product.imageUrl ?? undefined}
              alt={product.label}
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }}
            />
          ) : (
            <GarmentIcon size={40} />
          )}
        </div>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: C.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {product.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.pink }}>₹{product.offerPrice}</span>
            {product.offerPrice < product.actualPrice && (
              <span style={{ fontSize: 12, color: C.mid, textDecoration: 'line-through' }}>
                ₹{product.actualPrice}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no new errors from these two files.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/components/SubcategoryCard.tsx apps/catalogues-web/src/app/tryon-library-app/components/ProductCard.tsx
git commit -m "feat(web): add SubcategoryCard/ProductCard grid components for the mobile Try On Library rebuild"
```

---

### Task 7: `layout.tsx` — session gate moves up, with login form (incl. Google button)

**Files:**
- Modify: `apps/catalogues-web/src/app/tryon-library-app/layout.tsx`

This is the load-bearing change for real nested routes: every screen under `/tryon-library-app/*` renders through this layout, so the `checking / unauthed / authed` gate applies uniformly. Includes the login form with both the username/password path and the Google button (portal-gated per Tasks 1–2), and error-message handling for `?error=oauth_failed` / `?error=not_a_merchant`.

- [ ] **Step 1: Replace `layout.tsx`**

```tsx
'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';
import { Divider } from '@/components/ui/divider';
import { GoogleBtn } from '@/components/ui/google-btn';
import { catalogAppLogin, initCatalogAppToken } from './catalog-app-api';

type AuthState = 'checking' | 'authed' | 'unauthed';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: 'Google sign-in failed. Please try again.',
  not_a_merchant: "This Google account isn't enabled for virtual try-on yet. Contact support.",
};

function LoginFormInner({ onLoggedIn }: { onLoggedIn: () => void }) {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await catalogAppLogin(identifier, password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        padding: 20,
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 360,
          maxWidth: '100%',
          background: C.white,
          borderRadius: 14,
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 12px 48px rgba(0,0,0,0.12)',
        }}
      >
        <LogoAuth />
        <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Try On Library</h1>

        <GoogleBtn label="Continue with Google" next="/tryon-library-app" />
        <Divider label="Or Continue With" />

        {oauthError && ERROR_MESSAGES[oauthError] && (
          <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{ERROR_MESSAGES[oauthError]}</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="identifier" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Email or Username
          </label>
          <input
            id="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="password" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        {error && <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{
            height: 44,
            borderRadius: 8,
            border: 'none',
            background: C.dark,
            color: C.onDark,
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.white }} />}>
      <LoginFormInner onLoggedIn={onLoggedIn} />
    </Suspense>
  );
}

export const metadata = {
  title: 'Try On Library',
  manifest: '/tryon-library-app/manifest.webmanifest',
};

export default function TryonLibraryAppLayout({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;
    if ('serviceWorker' in navigator) {
      const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
      navigator.serviceWorker
        .register(`${BASE}/tryon-library-app-sw.js`, { scope: `${BASE}/tryon-library-app` })
        .catch(() => {});
    }
    (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api/catalog-app/refresh`, {
          method: 'POST',
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { accessToken?: string };
          if (data.accessToken) {
            initCatalogAppToken(data.accessToken);
            setAuthState('authed');
            return;
          }
        }
        setAuthState('unauthed');
      } catch {
        if (!cancelled) setAuthState('unauthed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleLoggedOut() {
    setAuthState('unauthed');
  }

  if (authState === 'checking') {
    return <div style={{ minHeight: '100vh', background: C.white }} />;
  }
  if (authState === 'unauthed') {
    return <LoginForm onLoggedIn={() => setAuthState('authed')} />;
  }
  return <>{children}</>;
}
```

Note: `metadata` export from a `'use client'` file is invalid in Next.js — it must move. Actually implement it this way instead: keep `layout.tsx` as a **server component wrapper** that exports `metadata` and renders a new client component `AuthGate.tsx` which holds all the state above. Redo Step 1 as two files:

- [ ] **Step 1 (corrected): Create `apps/catalogues-web/src/app/tryon-library-app/AuthGate.tsx`** with the exact content of the `layout.tsx` body above (the `LoginFormInner`, `LoginForm`, `AuthState` type, and default-exported gate component), renamed:

```tsx
'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';
import { Divider } from '@/components/ui/divider';
import { GoogleBtn } from '@/components/ui/google-btn';
import { catalogAppLogin, initCatalogAppToken } from './catalog-app-api';

type AuthState = 'checking' | 'authed' | 'unauthed';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: 'Google sign-in failed. Please try again.',
  not_a_merchant: "This Google account isn't enabled for virtual try-on yet. Contact support.",
};

function LoginFormInner({ onLoggedIn }: { onLoggedIn: () => void }) {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await catalogAppLogin(identifier, password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        padding: 20,
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 360,
          maxWidth: '100%',
          background: C.white,
          borderRadius: 14,
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 12px 48px rgba(0,0,0,0.12)',
        }}
      >
        <LogoAuth />
        <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Try On Library</h1>

        <GoogleBtn label="Continue with Google" next="/tryon-library-app" />
        <Divider label="Or Continue With" />

        {oauthError && ERROR_MESSAGES[oauthError] && (
          <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{ERROR_MESSAGES[oauthError]}</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="identifier" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Email or Username
          </label>
          <input
            id="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="password" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        {error && <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{
            height: 44,
            borderRadius: 8,
            border: 'none',
            background: C.dark,
            color: C.onDark,
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.white }} />}>
      <LoginFormInner onLoggedIn={onLoggedIn} />
    </Suspense>
  );
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;
    if ('serviceWorker' in navigator) {
      const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
      navigator.serviceWorker
        .register(`${BASE}/tryon-library-app-sw.js`, { scope: `${BASE}/tryon-library-app` })
        .catch(() => {});
    }
    (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api/catalog-app/refresh`, {
          method: 'POST',
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { accessToken?: string };
          if (data.accessToken) {
            initCatalogAppToken(data.accessToken);
            setAuthState('authed');
            return;
          }
        }
        setAuthState('unauthed');
      } catch {
        if (!cancelled) setAuthState('unauthed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleLoggedOut() {
    setAuthState('unauthed');
  }

  if (authState === 'checking') {
    return <div style={{ minHeight: '100vh', background: C.white }} />;
  }
  if (authState === 'unauthed') {
    return <LoginForm onLoggedIn={() => setAuthState('authed')} />;
  }
  return <>{children}</>;
}
```

Note: `handleLoggedOut` is defined but not directly used inside `AuthGate` itself — it needs to be threaded down to every screen so their `ScreenHeader`/`LibraryUserMenu` can call it on logout. Pass it via React context instead of prop-drilling through every route:

- [ ] **Step 2: Create `apps/catalogues-web/src/app/tryon-library-app/logged-out-context.tsx`**

```tsx
'use client';
import { createContext, useContext } from 'react';

const LoggedOutContext = createContext<(() => void) | null>(null);

export function LoggedOutProvider({
  onLoggedOut,
  children,
}: {
  onLoggedOut: () => void;
  children: React.ReactNode;
}) {
  return <LoggedOutContext.Provider value={onLoggedOut}>{children}</LoggedOutContext.Provider>;
}

/** Every screen's ScreenHeader (root variant) calls this on logout. Throws if used outside AuthGate — every route under /tryon-library-app is wrapped by it, so this should never happen. */
export function useLoggedOut(): () => void {
  const fn = useContext(LoggedOutContext);
  if (!fn) throw new Error('useLoggedOut must be used within the Try On Library AuthGate');
  return fn;
}
```

- [ ] **Step 3: Update `AuthGate.tsx`'s final return to provide the context**

Replace the last two lines of `AuthGate` (`if (authState === 'unauthed') { ... } return <>{children}</>;`) with:

```tsx
  if (authState === 'unauthed') {
    return <LoginForm onLoggedIn={() => setAuthState('authed')} />;
  }
  return <LoggedOutProvider onLoggedOut={handleLoggedOut}>{children}</LoggedOutProvider>;
```

And add the import at the top of `AuthGate.tsx`:

```tsx
import { LoggedOutProvider } from './logged-out-context';
```

- [ ] **Step 4: Update `ScreenHeader.tsx` (from Task 4) to use the context instead of a prop for the root variant**

In `apps/catalogues-web/src/app/tryon-library-app/components/ScreenHeader.tsx`, change the type and root-variant rendering:

```tsx
type ScreenHeaderProps =
  | { variant: 'root'; title: string }
  | { variant: 'back'; title: string; subtitle?: string; onBack: () => void };
```

And add the import + usage:

```tsx
import { useLoggedOut } from '../logged-out-context';
```

Inside the component body, before the `return`:

```tsx
  const onLoggedOut = props.variant === 'root' ? useLoggedOut() : undefined;
```

(Calling a hook conditionally like this violates the Rules of Hooks if `props.variant` can change across renders for the same component instance — it can't here, since each screen always renders `ScreenHeader` with a fixed, hardcoded `variant` literal, never a variable one. This is a common, safe pattern for this exact situation, but to keep it unconditionally rule-compliant, call the hook unconditionally instead:)

```tsx
export function ScreenHeader(props: ScreenHeaderProps) {
  const onLoggedOut = useLoggedOut();
  return (
    // ...
        {props.variant === 'root' && <LibraryUserMenu onLoggedOut={onLoggedOut} />}
    // ...
  );
}
```

This calls `useLoggedOut()` unconditionally (always safe — every screen is always inside the provider), and only *uses* the value when `variant === 'root'`.

- [ ] **Step 5: Rewrite `layout.tsx` as a thin server-component wrapper**

```tsx
import AuthGate from './AuthGate';

export const metadata = {
  title: 'Try On Library',
  manifest: '/tryon-library-app/manifest.webmanifest',
};

export default function TryonLibraryAppLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: errors remaining only from `page.tsx` still importing the deleted `LibraryContent` — fixed in Task 8. No errors from `layout.tsx`, `AuthGate.tsx`, `logged-out-context.tsx`, or `ScreenHeader.tsx`.

- [ ] **Step 7: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/layout.tsx apps/catalogues-web/src/app/tryon-library-app/AuthGate.tsx apps/catalogues-web/src/app/tryon-library-app/logged-out-context.tsx apps/catalogues-web/src/app/tryon-library-app/components/ScreenHeader.tsx
git commit -m "feat(web): move the Try On Library session gate from page.tsx up into layout.tsx"
```

---

### Task 8: `page.tsx` — Subcategories screen (root)

**Files:**
- Modify: `apps/catalogues-web/src/app/tryon-library-app/page.tsx`

Replaces the old `page.tsx` (which held the auth gate, now in `AuthGate.tsx`) with the actual Subcategories screen content: category tabs (URL search param, not local state), 2-column grid of `SubcategoryCard`, FAB, merchant-gate empty state, delete confirmation.

- [ ] **Step 1: Replace `page.tsx`**

```tsx
'use client';
import type {
  MerchantCatalogCategory as Category,
  MerchantCatalogSubcategory,
  MerchantCatalogSubcategoryListResponse,
} from '@tryme/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { GarmentIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CategoryTabs } from './components/CategoryTabs';
import { Fab } from './components/Fab';
import { ScreenHeader } from './components/ScreenHeader';
import { SubcategoryCard } from './components/SubcategoryCard';
import { catalogAppApi as api, CatalogAppSessionExpiredError } from './catalog-app-api';
import { useLoggedOut } from './logged-out-context';

// "not a merchant account" / "merchant account inactive" — thrown by requireMerchant
// (apps/api/src/plugins/portal-auth.ts) when the logged-in user has no merchants row.
function isMerchantGateError(err: unknown): boolean {
  return err instanceof Error && /merchant account/i.test(err.message);
}

function SubcategoriesScreenInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const onLoggedOut = useLoggedOut();

  const selectedCategory = (searchParams.get('category') as Category | null) ?? 'men';
  const [deleteTarget, setDeleteTarget] = useState<MerchantCatalogSubcategory | undefined>(
    undefined,
  );

  function selectCategory(category: Category) {
    const params = new URLSearchParams(searchParams);
    params.set('category', category);
    router.replace(`/tryon-library-app?${params.toString()}`);
  }

  const subcategoriesQuery = useQuery({
    queryKey: ['merchant-catalog-subcategories'],
    queryFn: () =>
      api.get<MerchantCatalogSubcategoryListResponse>('/v1/merchant/catalog/subcategories'),
  });

  const merchantGated = isMerchantGateError(subcategoriesQuery.error);

  if (subcategoriesQuery.error instanceof CatalogAppSessionExpiredError) {
    onLoggedOut();
  }

  const subcategories = subcategoriesQuery.data?.items ?? [];

  const garmentTypesQuery = useQuery({
    queryKey: ['garment-types', selectedCategory],
    queryFn: () =>
      api.get<{ items: { id: string; label: string }[] }>(
        `/v1/models/garment-types?gender=${selectedCategory}`,
      ),
    enabled: !merchantGated,
  });
  const garmentTypes = garmentTypesQuery.data?.items ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.del<void>(`/v1/merchant/catalog/subcategories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      setDeleteTarget(undefined);
    },
  });

  if (subcategoriesQuery.isLoading) {
    return (
      <>
        <ScreenHeader variant="root" title="Try On Library" />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
          }}
        >
          <div style={{ color: C.mid, fontSize: 14 }}>Loading catalogue…</div>
        </div>
      </>
    );
  }

  if (merchantGated) {
    return (
      <>
        <ScreenHeader variant="root" title="Try On Library" />
        <div
          style={{
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <h3 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: 0 }}>
            Merchant account required
          </h3>
          <p style={{ color: C.light, fontSize: 14, margin: 0, maxWidth: 320 }}>
            This account isn't enabled for virtual try-on yet. Contact support to get your
            merchant account activated.
          </p>
        </div>
      </>
    );
  }

  const visibleSubs = subcategories.filter((s) => s.category === selectedCategory);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader variant="root" title="Try On Library" />
      <CategoryTabs selected={selectedCategory} onSelect={selectCategory} />

      {visibleSubs.length === 0 ? (
        <div
          style={{
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ color: C.pink, opacity: 0.8 }}>
            <GarmentIcon size={44} />
          </div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: C.text, margin: 0 }}>
            No subcategories yet
          </h3>
          <p style={{ color: C.light, fontSize: 13, margin: 0, maxWidth: 280 }}>
            Tap the + button to create your first subcategory.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            padding: '4px 16px 100px',
          }}
        >
          {visibleSubs.map((sub) => {
            const garmentTypeLabel =
              garmentTypes.find((g) => g.id === sub.garmentSubcategoryId)?.label || 'Unknown';
            return (
              <SubcategoryCard
                key={sub.id}
                subcategory={sub}
                garmentTypeLabel={garmentTypeLabel}
                onOpen={() => router.push(`/tryon-library-app/subcategory/${sub.id}`)}
                onDelete={() => setDeleteTarget(sub)}
              />
            );
          })}
        </div>
      )}

      <Fab onClick={() => router.push('/tryon-library-app/add-subcategory')} label="Add Subcategory" />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Subcategory"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? All products inside it will also be deleted.`}
        confirmLabel="Delete"
        danger
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(undefined)}
      />
    </div>
  );
}

export default function SubcategoriesScreen() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.white }} />}>
      <SubcategoriesScreenInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors from `page.tsx`.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/page.tsx
git commit -m "feat(web): rebuild the Try On Library Subcategories screen mobile-first"
```

---

### Task 9: Add Subcategory screen

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/add-subcategory/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { MerchantCatalogCategory as Category, MerchantCatalogSubcategory } from '@tryme/types';
import { C } from '@/components/tokens';
import { GradBtn } from '@/components/ui/grad-btn';
import { PremiumSelect } from '@/components/ui/premium-select';
import { catalogAppApi as api } from '../catalog-app-api';
import { ScreenHeader } from '../components/ScreenHeader';
import { StickyBottomBar } from '../components/StickyBottomBar';

function AddSubcategoryScreenInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const category = (searchParams.get('category') as Category | null) ?? 'men';

  const [name, setName] = useState('');
  const [garmentSubcategoryId, setGarmentSubcategoryId] = useState('');
  const [error, setError] = useState('');

  const garmentTypesQuery = useQuery({
    queryKey: ['garment-types', category],
    queryFn: () =>
      api.get<{ items: { id: string; label: string }[] }>(
        `/v1/models/garment-types?gender=${category}`,
      ),
  });
  const garmentTypes = garmentTypesQuery.data?.items ?? [];
  const garmentOptions = garmentTypes.map((g) => ({ value: g.id, label: g.label }));

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<MerchantCatalogSubcategory>('/v1/merchant/catalog/subcategories', {
        category,
        name: name.trim(),
        garmentSubcategoryId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      router.back();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to save subcategory.');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!name.trim() || !garmentSubcategoryId) return;
    createMutation.mutate();
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader variant="back" title="Add Subcategory" onBack={() => router.back()} />

      <form
        onSubmit={handleSubmit}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20, padding: 16 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="sub-name" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Name <span style={{ color: C.pink }}>*</span>
          </label>
          <input
            id="sub-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Summer Collection"
            style={{
              width: '100%',
              height: 48,
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              padding: '0 14px',
              fontSize: 15,
              fontFamily: 'inherit',
              background: C.field,
              color: C.text,
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Garment Type <span style={{ color: C.pink }}>*</span>
          </span>
          <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.field }}>
            <PremiumSelect
              value={garmentSubcategoryId}
              onChange={(val) => setGarmentSubcategoryId(val as string)}
              options={garmentOptions}
              fullWidth
              height={48}
              placeholder="Select garment type…"
            />
          </div>
        </div>

        {error && <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{error}</p>}
      </form>

      <StickyBottomBar>
        <button
          type="button"
          onClick={() => router.back()}
          disabled={createMutation.isPending}
          style={{
            flex: 1,
            height: 48,
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            background: C.white,
            color: C.text,
            fontFamily: 'inherit',
            fontSize: 15,
            fontWeight: 600,
            cursor: createMutation.isPending ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
        <div style={{ flex: 1 }}>
          <GradBtn
            type="button"
            onClick={() => {
              if (!name.trim() || !garmentSubcategoryId) {
                setError('Please fill in the name and garment type.');
                return;
              }
              setError('');
              createMutation.mutate();
            }}
            disabled={createMutation.isPending}
            style={{ width: '100%', height: 48 }}
          >
            {createMutation.isPending ? 'Saving…' : 'Save'}
          </GradBtn>
        </div>
      </StickyBottomBar>
    </div>
  );
}

export default function AddSubcategoryScreen() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.white }} />}>
      <AddSubcategoryScreenInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors. (`GradBtn`'s `style` prop merges with its own internal style object — confirmed from `apps/catalogues-web/src/components/ui/grad-btn.tsx`, which spreads `...style` last, so `width: '100%'` here overrides its default `padding`-only sizing correctly.)

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/add-subcategory/page.tsx
git commit -m "feat(web): add the Add Subcategory full-screen step"
```

---

### Task 10: Products screen (per subcategory)

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/page.tsx`

Fetches the subcategory's own metadata by re-using the already-cached `['merchant-catalog-subcategories']` query (same key as the root screen) and finding the row by `id` — no new backend endpoint, per the spec.

- [ ] **Step 1: Create the file**

```tsx
'use client';
import type {
  MerchantCatalogItem,
  MerchantCatalogListResponse,
  MerchantCatalogSubcategoryListResponse,
} from '@tryme/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { GarmentIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { catalogAppApi as api } from '../../catalog-app-api';
import { Fab } from '../../components/Fab';
import { ProductCard } from '../../components/ProductCard';
import { ScreenHeader } from '../../components/ScreenHeader';

export default function ProductsScreen() {
  const params = useParams<{ id: string }>();
  const subcategoryId = params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<MerchantCatalogItem | undefined>(undefined);

  const subcategoriesQuery = useQuery({
    queryKey: ['merchant-catalog-subcategories'],
    queryFn: () =>
      api.get<MerchantCatalogSubcategoryListResponse>('/v1/merchant/catalog/subcategories'),
  });
  const subcategory = subcategoriesQuery.data?.items.find((s) => s.id === subcategoryId);

  const garmentTypesQuery = useQuery({
    queryKey: ['garment-types', subcategory?.category],
    queryFn: () =>
      api.get<{ items: { id: string; label: string }[] }>(
        `/v1/models/garment-types?gender=${subcategory?.category}`,
      ),
    enabled: !!subcategory,
  });
  const garmentTypeLabel =
    garmentTypesQuery.data?.items.find((g) => g.id === subcategory?.garmentSubcategoryId)?.label ??
    'Unknown';

  const productsQuery = useQuery({
    queryKey: ['merchant-catalog-products', subcategoryId],
    queryFn: () =>
      api.get<MerchantCatalogListResponse>(`/v1/merchant/catalog?subcategoryId=${subcategoryId}`),
  });
  const products = productsQuery.data?.items ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.del<void>(`/v1/merchant/catalog/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] }); // productCount changed
      setDeleteTarget(undefined);
    },
  });

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader
        variant="back"
        title={subcategory?.name ?? 'Products'}
        subtitle={garmentTypeLabel}
        onBack={() => router.push('/tryon-library-app')}
      />

      <div style={{ padding: '12px 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => router.push(`/tryon-library-app/subcategory/${subcategoryId}/bulk-upload`)}
          className="focus-ring hover-surface"
          style={{
            height: 36,
            padding: '0 14px',
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            background: C.card,
            color: C.text,
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Bulk Upload
        </button>
      </div>

      {productsQuery.isLoading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '40vh',
          }}
        >
          <div style={{ color: C.mid, fontSize: 14 }}>Loading products…</div>
        </div>
      ) : products.length === 0 ? (
        <div
          style={{
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ color: C.pink, opacity: 0.8 }}>
            <GarmentIcon size={44} />
          </div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: C.text, margin: 0 }}>
            No products yet
          </h3>
          <p style={{ color: C.light, fontSize: 13, margin: 0, maxWidth: 280 }}>
            Tap the + button to add your first product.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            padding: '12px 16px 100px',
          }}
        >
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onOpen={() =>
                router.push(
                  `/tryon-library-app/subcategory/${subcategoryId}/edit-product/${product.id}`,
                )
              }
              onDelete={() => setDeleteTarget(product)}
            />
          ))}
        </div>
      )}

      <Fab
        onClick={() => router.push(`/tryon-library-app/subcategory/${subcategoryId}/add-product`)}
        label="Add Product"
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Product"
        message={`Are you sure you want to delete "${deleteTarget?.label}"?`}
        confirmLabel="Delete"
        danger
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(undefined)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/subcategory/\[id\]/page.tsx
git commit -m "feat(web): add the Products screen for a subcategory"
```

---

### Task 11: Shared `ProductForm` component (used by Add and Edit Product)

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/components/ProductForm.tsx`

Carries over the exact image-mode toggle / generate / save logic from the deleted `ProductModal.tsx`, adapted to a full-screen layout with a sticky bottom Save button instead of a modal footer, and `router`-based navigation instead of an `onClose` callback.

- [ ] **Step 1: Create the file**

```tsx
'use client';
import type { MerchantCatalogItem } from '@tryme/types';
import { useEffect, useRef, useState } from 'react';
import { SpinnerIcon, UploadIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { GradBtn } from '@/components/ui/grad-btn';
import { catalogAppApi as api } from '../catalog-app-api';
import {
  deleteProduct,
  finalizeGeneratedProduct,
  pollGenerateJob,
  presignAndUpload,
} from '../catalog-app-helpers';
import { StickyBottomBar } from './StickyBottomBar';

export function ProductForm({
  subcategoryId,
  initialData,
  onSaved,
  onCancel,
}: {
  subcategoryId: string;
  initialData?: MerchantCatalogItem;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEditing = !!initialData;

  const [label, setLabel] = useState(initialData?.label ?? '');
  const [sku, setSku] = useState(initialData?.sku ?? '');
  const [actualPrice, setActualPrice] = useState(initialData?.actualPrice.toString() ?? '');
  const [offerPrice, setOfferPrice] = useState(initialData?.offerPrice.toString() ?? '');
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);

  const [imageMode, setImageMode] = useState<'catalogue' | 'flat'>('catalogue');
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [generatedItem, setGeneratedItem] = useState<MerchantCatalogItem | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | undefined>(undefined);
  previewUrlRef.current = previewUrl;
  const generatedItemRef = useRef<MerchantCatalogItem | undefined>(undefined);
  generatedItemRef.current = generatedItem;

  // Clean up on unmount: revoke the object URL, and best-effort delete an
  // unsaved generated product so it doesn't sit as a $0 orphan.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (generatedItemRef.current) void deleteProduct(generatedItemRef.current.id);
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setErrorMsg(undefined);
    if (imageMode === 'flat' && generatedItem) {
      void deleteProduct(generatedItem.id);
      setGeneratedItem(undefined);
    }
  };

  const handleGenerate = async () => {
    if (!selectedFile) return;
    setIsGenerating(true);
    setErrorMsg(undefined);
    try {
      if (generatedItem) {
        await deleteProduct(generatedItem.id);
        setGeneratedItem(undefined);
      }
      const { r2Key: flatImageKey } = await presignAndUpload(selectedFile, 'flat');
      const { jobId } = await api.post<{ jobId: string }>('/v1/merchant/catalog/generate', {
        subcategoryId,
        flatImageKey,
      });
      const status = await pollGenerateJob(jobId);
      if (status.status !== 'COMPLETED') {
        throw new Error(
          status.errorCode ? `Generation failed (${status.errorCode})` : 'Generation failed. Please try again.',
        );
      }
      const item = await finalizeGeneratedProduct(jobId, subcategoryId);
      setGeneratedItem(item);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  const actualPriceNum = actualPrice ? parseInt(actualPrice, 10) : 0;
  const offerPriceNum = offerPrice ? parseInt(offerPrice, 10) : 0;
  const hasPriceError = offerPriceNum > actualPriceNum;
  const missingImage =
    !isEditing && ((imageMode === 'catalogue' && !selectedFile) || (imageMode === 'flat' && !generatedItem));
  const isSaveDisabled = hasPriceError || isGenerating || isSaving || missingImage;

  const handleSubmit = async () => {
    if (!label.trim() || !sku.trim() || !actualPrice || !offerPrice) return;
    if (isSaveDisabled) return;

    setIsSaving(true);
    setErrorMsg(undefined);
    try {
      const priceFields = {
        label: label.trim(),
        sku: sku.trim(),
        actualPrice: actualPriceNum,
        offerPrice: offerPriceNum,
      };

      if (isEditing && initialData) {
        await api.patch(`/v1/merchant/catalog/${initialData.id}`, priceFields);
      } else if (imageMode === 'flat') {
        if (!generatedItem) throw new Error('Generate the catalogue image first.');
        await api.patch(`/v1/merchant/catalog/${generatedItem.id}`, priceFields);
      } else {
        if (!selectedFile) throw new Error('Upload a product image first.');
        const [{ r2Key }, { r2Key: thumbnailKey }] = await Promise.all([
          presignAndUpload(selectedFile, 'image'),
          presignAndUpload(selectedFile, 'thumbnail'),
        ]);
        await api.post('/v1/merchant/catalog', { subcategoryId, r2Key, thumbnailKey, ...priceFields });
      }

      setGeneratedItem(undefined); // saved — don't clean it up on unmount
      onSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save product.');
    } finally {
      setIsSaving(false);
    }
  };

  const busy = isGenerating || isSaving;
  const displayImageUrl = previewUrl ?? initialData?.imageUrl ?? undefined;

  return (
    <>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20, padding: 16 }}>
        {isEditing ? (
          <div
            style={{
              height: 200,
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              background: C.field,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {displayImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              // biome-ignore lint/performance/noImgElement: presigned R2 preview
              <img
                src={displayImageUrl}
                alt={label || 'Product'}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <UploadIcon size={28} />
            )}
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                overflow: 'hidden',
                background: C.white,
              }}
            >
              <button
                type="button"
                onClick={() => setImageMode('catalogue')}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: '12px 8px',
                  border: 'none',
                  background: imageMode === 'catalogue' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
                  color: imageMode === 'catalogue' ? C.pink : C.text,
                  fontWeight: imageMode === 'catalogue' ? 600 : 500,
                  fontSize: 14,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  borderRight: `1px solid ${C.border2}`,
                }}
              >
                Catalogue Image
              </button>
              <button
                type="button"
                onClick={() => setImageMode('flat')}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: '12px 8px',
                  border: 'none',
                  background: imageMode === 'flat' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
                  color: imageMode === 'flat' ? C.pink : C.text,
                  fontWeight: imageMode === 'flat' ? 600 : 500,
                  fontSize: 14,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Flat Image
              </button>
            </div>

            {imageMode === 'catalogue' ? (
              <div
                // biome-ignore lint/a11y/useKeyWithClickEvents: simple click trigger, no keyboard-only interaction offered elsewhere for file pickers in this codebase
                // biome-ignore lint/a11y/noStaticElementInteractions: same as above
                onClick={() => !busy && fileInputRef.current?.click()}
                style={{
                  height: 180,
                  borderRadius: 8,
                  border: `1px dashed ${C.border2}`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  overflow: 'hidden',
                  position: 'relative',
                  gap: 8,
                }}
                className="hover-surface"
              >
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: local preview
                  <img
                    src={previewUrl}
                    alt="Preview"
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <>
                    <div style={{ color: C.mid }}>
                      <UploadIcon size={28} />
                    </div>
                    <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                      Tap to choose a product photo
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {!previewUrl ? (
                  <div
                    // biome-ignore lint/a11y/useKeyWithClickEvents: simple click trigger
                    // biome-ignore lint/a11y/noStaticElementInteractions: same as above
                    onClick={() => !busy && fileInputRef.current?.click()}
                    style={{
                      height: 180,
                      borderRadius: 8,
                      border: `1px dashed ${C.border2}`,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      gap: 8,
                    }}
                    className="hover-surface"
                  >
                    <div style={{ color: C.mid }}>
                      <UploadIcon size={28} />
                    </div>
                    <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                      Tap to upload a flat garment photo
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div
                      style={{
                        height: 160,
                        borderRadius: 8,
                        border: `1px solid ${C.border2}`,
                        background: C.field,
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {/* biome-ignore lint/performance/noImgElement: local/generated preview */}
                      <img
                        src={generatedItem?.imageUrl ?? previewUrl}
                        alt="Flat Garment"
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                      {generatedItem && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            background: C.pink,
                            color: C.white,
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            textTransform: 'uppercase',
                          }}
                        >
                          Generated
                        </div>
                      )}
                    </div>
                    {!generatedItem ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <GradBtn type="button" onClick={handleGenerate} disabled={isGenerating}>
                          {isGenerating && <SpinnerIcon size={14} />}
                          {isGenerating ? 'Generating…' : 'Generate Catalogue Image'}
                        </GradBtn>
                        <button
                          type="button"
                          onClick={() => {
                            if (previewUrl) URL.revokeObjectURL(previewUrl);
                            setSelectedFile(undefined);
                            setPreviewUrl(undefined);
                          }}
                          disabled={isGenerating}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: C.mid,
                            fontSize: 13,
                            fontWeight: 500,
                            cursor: isGenerating ? 'not-allowed' : 'pointer',
                            textDecoration: 'underline',
                            alignSelf: 'flex-start',
                          }}
                        >
                          Choose a different image
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={handleGenerate}
                          disabled={busy}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: C.text,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            textDecoration: 'underline',
                          }}
                        >
                          Regenerate
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (previewUrl) URL.revokeObjectURL(previewUrl);
                            if (generatedItem) void deleteProduct(generatedItem.id);
                            setSelectedFile(undefined);
                            setPreviewUrl(undefined);
                            setGeneratedItem(undefined);
                          }}
                          disabled={busy}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: C.mid,
                            fontSize: 13,
                            fontWeight: 500,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            textDecoration: 'underline',
                          }}
                        >
                          Change image
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          tabIndex={-1}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="product-name" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Product Name <span style={{ color: C.pink }}>*</span>
          </label>
          <input
            id="product-name"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Slim Fit Cotton Shirt"
            style={{
              width: '100%',
              height: 48,
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              padding: '0 14px',
              fontSize: 15,
              fontFamily: 'inherit',
              background: C.field,
              color: C.text,
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="product-sku" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            SKU <span style={{ color: C.pink }}>*</span>
          </label>
          <input
            id="product-sku"
            required
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="e.g. SH-COT-BLU-S"
            style={{
              width: '100%',
              height: 48,
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              padding: '0 14px',
              fontSize: 15,
              fontFamily: 'inherit',
              background: C.field,
              color: C.text,
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="product-actual-price" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Actual Price <span style={{ color: C.pink }}>*</span>
          </label>
          <div style={{ position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 15,
                color: C.mid,
                fontWeight: 600,
              }}
            >
              ₹
            </span>
            <input
              id="product-actual-price"
              required
              type="number"
              min="0"
              step="1"
              value={actualPrice}
              onChange={(e) => setActualPrice(e.target.value)}
              placeholder="0"
              style={{
                width: '100%',
                height: 48,
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                padding: '0 14px 0 28px',
                fontSize: 15,
                fontFamily: 'inherit',
                background: C.field,
                color: C.text,
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="product-offer-price" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Offer Price <span style={{ color: C.pink }}>*</span>
          </label>
          <div style={{ position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 15,
                color: C.mid,
                fontWeight: 600,
              }}
            >
              ₹
            </span>
            <input
              id="product-offer-price"
              required
              type="number"
              min="0"
              step="1"
              value={offerPrice}
              onChange={(e) => setOfferPrice(e.target.value)}
              placeholder="0"
              style={{
                width: '100%',
                height: 48,
                borderRadius: 8,
                border: `1px solid ${hasPriceError ? C.pink : C.border2}`,
                padding: '0 14px 0 28px',
                fontSize: 15,
                fontFamily: 'inherit',
                background: C.field,
                color: C.text,
              }}
            />
          </div>
        </div>

        {hasPriceError && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(245,92,122,0.06)',
              border: `1px solid ${C.pink}`,
              fontSize: 13,
              color: C.pink,
            }}
          >
            Offer price cannot be greater than the actual price.
          </div>
        )}

        {errorMsg && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(245,92,122,0.06)',
              border: `1px solid ${C.pink}`,
              fontSize: 13,
              color: C.pink,
            }}
          >
            {errorMsg}
          </div>
        )}
      </div>

      <StickyBottomBar>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{
            flex: 1,
            height: 48,
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            background: C.white,
            color: C.text,
            fontFamily: 'inherit',
            fontSize: 15,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
        <div style={{ flex: 1 }}>
          <GradBtn
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSaveDisabled}
            style={{ width: '100%', height: 48 }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </GradBtn>
        </div>
      </StickyBottomBar>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors. (`ProductForm` is not yet imported anywhere — that's fine, it's used by Tasks 12 and 13.)

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/components/ProductForm.tsx
git commit -m "feat(web): add the shared ProductForm component for Add/Edit Product screens"
```

---

### Task 12: Add Product screen

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/add-product/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { C } from '@/components/tokens';
import { ProductForm } from '../../../components/ProductForm';
import { ScreenHeader } from '../../../components/ScreenHeader';

export default function AddProductScreen() {
  const params = useParams<{ id: string }>();
  const subcategoryId = params.id;
  const router = useRouter();
  const qc = useQueryClient();

  function goBackToProducts() {
    router.push(`/tryon-library-app/subcategory/${subcategoryId}`);
  }

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
    qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
    goBackToProducts();
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader variant="back" title="Add Product" onBack={goBackToProducts} />
      <ProductForm subcategoryId={subcategoryId} onSaved={handleSaved} onCancel={goBackToProducts} />
    </div>
  );
}
```

Note: `C` is imported but unused in this file as written — remove it (it was left over from copy-paste). Corrected version:

```tsx
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { ProductForm } from '../../../components/ProductForm';
import { ScreenHeader } from '../../../components/ScreenHeader';

export default function AddProductScreen() {
  const params = useParams<{ id: string }>();
  const subcategoryId = params.id;
  const router = useRouter();
  const qc = useQueryClient();

  function goBackToProducts() {
    router.push(`/tryon-library-app/subcategory/${subcategoryId}`);
  }

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
    qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
    goBackToProducts();
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader variant="back" title="Add Product" onBack={goBackToProducts} />
      <ProductForm subcategoryId={subcategoryId} onSaved={handleSaved} onCancel={goBackToProducts} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/add-product/page.tsx"
git commit -m "feat(web): add the Add Product full-screen step"
```

---

### Task 13: Edit Product screen

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/edit-product/[productId]/page.tsx`

Reuses the cached `['merchant-catalog-products', subcategoryId]` query (warm if navigated from the Products screen; refetches normally on a cold direct load) and finds the product by `productId`, per the spec's "no new backend endpoint" decision.

- [ ] **Step 1: Create the file**

```tsx
'use client';
import type { MerchantCatalogListResponse } from '@tryme/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { C } from '@/components/tokens';
import { catalogAppApi as api } from '../../../../catalog-app-api';
import { ProductForm } from '../../../../components/ProductForm';
import { ScreenHeader } from '../../../../components/ScreenHeader';

export default function EditProductScreen() {
  const params = useParams<{ id: string; productId: string }>();
  const subcategoryId = params.id;
  const productId = params.productId;
  const router = useRouter();
  const qc = useQueryClient();

  const productsQuery = useQuery({
    queryKey: ['merchant-catalog-products', subcategoryId],
    queryFn: () =>
      api.get<MerchantCatalogListResponse>(`/v1/merchant/catalog?subcategoryId=${subcategoryId}`),
  });
  const product = productsQuery.data?.items.find((p) => p.id === productId);

  function goBackToProducts() {
    router.push(`/tryon-library-app/subcategory/${subcategoryId}`);
  }

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
    qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
    goBackToProducts();
  }

  if (productsQuery.isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <ScreenHeader variant="back" title="Edit Product" onBack={goBackToProducts} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '40vh',
          }}
        >
          <div style={{ color: C.mid, fontSize: 14 }}>Loading product…</div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <ScreenHeader variant="back" title="Edit Product" onBack={goBackToProducts} />
        <div style={{ padding: '64px 24px', textAlign: 'center' }}>
          <p style={{ color: C.mid, fontSize: 14 }}>
            This product couldn't be found. It may have been deleted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader variant="back" title="Edit Product" onBack={goBackToProducts} />
      <ProductForm
        subcategoryId={subcategoryId}
        initialData={product}
        onSaved={handleSaved}
        onCancel={goBackToProducts}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/edit-product/[productId]/page.tsx"
git commit -m "feat(web): add the Edit Product full-screen step"
```

---

### Task 14: Bulk Upload screen

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx`

Carries over the queue/generate/price logic from the deleted `BulkUploadModal.tsx`, replacing the drag-and-drop dropzone with a native multi-photo picker (`<input type="file" multiple>` behind a full-width tap target) and the modal chrome with a full-screen layout + sticky bottom bar, per the spec.

- [ ] **Step 1: Create the file**

```tsx
'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SpinnerIcon, TrashIcon, UploadIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { GradBtn } from '@/components/ui/grad-btn';
import { catalogAppApi as api } from '../../../catalog-app-api';
import {
  deleteProduct,
  finalizeGeneratedProduct,
  pollGenerateBatch,
  presignAndUpload,
} from '../../../catalog-app-helpers';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { StickyBottomBar } from '../../../components/StickyBottomBar';

interface QueueItem {
  id: string;
  file: File;
  fileUrl: string;
  status: 'queued' | 'uploading' | 'generating' | 'generated' | 'failed';
  jobId?: string;
  itemId?: string;
  sku: string;
  actualPrice: string;
  offerPrice: string;
  hasError: boolean;
  errorMessage?: string;
}

const generateId = () => Math.random().toString(36).substring(2, 9);

export default function BulkUploadScreen() {
  const params = useParams<{ id: string }>();
  const subcategoryId = params.id;
  const router = useRouter();
  const qc = useQueryClient();

  const [items, setItems] = useState<QueueItem[]>([]);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<QueueItem[]>([]);
  itemsRef.current = items;
  const finalizingJobIds = useRef<Set<string>>(new Set());

  const [globalActual, setGlobalActual] = useState('');
  const [globalOffer, setGlobalOffer] = useState('');

  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.fileUrl);
        if (item.status === 'generated' && item.itemId) void deleteProduct(item.itemId);
      }
    };
  }, []);

  const busy = isGeneratingAll || isSaving;

  function goBackToProducts() {
    router.push(`/tryon-library-app/subcategory/${subcategoryId}`);
  }

  const processFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        id: generateId(),
        file,
        fileUrl: URL.createObjectURL(file),
        status: 'queued',
        sku: '',
        actualPrice: '',
        offerPrice: '',
        hasError: false,
      }));
    setItems((prev) => [...prev, ...newItems]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    e.target.value = '';
  };

  const finalizeCompletedJob = async (jobId: string) => {
    if (finalizingJobIds.current.has(jobId)) return;
    finalizingJobIds.current.add(jobId);
    try {
      const item = await finalizeGeneratedProduct(jobId, subcategoryId);
      setItems((prev) =>
        prev.map((p) =>
          p.jobId === jobId
            ? { ...p, status: 'generated', itemId: item.id, fileUrl: item.imageUrl ?? p.fileUrl }
            : p,
        ),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((p) =>
          p.jobId === jobId
            ? { ...p, status: 'failed', hasError: true, errorMessage: err instanceof Error ? err.message : 'Import failed' }
            : p,
        ),
      );
    }
  };

  const handleGenerateAll = async () => {
    const queued = items.filter((i) => i.status === 'queued');
    if (queued.length === 0) return;
    setIsGeneratingAll(true);
    setItems((prev) => prev.map((i) => (i.status === 'queued' ? { ...i, status: 'uploading' } : i)));

    const uploaded: { id: string; flatImageKey: string }[] = [];
    for (const item of queued) {
      try {
        const { r2Key } = await presignAndUpload(item.file, 'flat');
        uploaded.push({ id: item.id, flatImageKey: r2Key });
      } catch (err) {
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? { ...p, status: 'failed', hasError: true, errorMessage: err instanceof Error ? err.message : 'Upload failed' }
              : p,
          ),
        );
      }
    }

    if (uploaded.length === 0) {
      setIsGeneratingAll(false);
      return;
    }

    setItems((prev) =>
      prev.map((p) => (uploaded.some((u) => u.id === p.id) ? { ...p, status: 'generating' } : p)),
    );

    let jobIds: string[] = [];
    let failures: Array<{ flatImageKey: string; error: string }> = [];
    try {
      const res = await api.post<{ jobIds: string[]; failures: Array<{ flatImageKey: string; error: string }> }>(
        '/v1/merchant/catalog/generate-bulk',
        { subcategoryId, flatImageKeys: uploaded.map((u) => u.flatImageKey) },
      );
      jobIds = res.jobIds;
      failures = res.failures;
    } catch (err) {
      setItems((prev) =>
        prev.map((p) =>
          uploaded.some((u) => u.id === p.id)
            ? { ...p, status: 'failed', hasError: true, errorMessage: err instanceof Error ? err.message : 'Failed to enqueue' }
            : p,
        ),
      );
      setIsGeneratingAll(false);
      return;
    }

    const failedKeys = new Map(failures.map((f) => [f.flatImageKey, f.error]));
    const succeeded = uploaded.filter((u) => !failedKeys.has(u.flatImageKey));
    // generate-bulk returns jobIds in the same order as the flatImageKeys that succeeded.
    const jobIdByLocalId = new Map(succeeded.map((u, idx) => [u.id, jobIds[idx]]));

    setItems((prev) =>
      prev.map((p) => {
        const jobId = jobIdByLocalId.get(p.id);
        if (jobId) return { ...p, jobId };
        const uploadedEntry = uploaded.find((u) => u.id === p.id);
        const error = uploadedEntry ? failedKeys.get(uploadedEntry.flatImageKey) : undefined;
        if (error) return { ...p, status: 'failed', hasError: true, errorMessage: error };
        return p;
      }),
    );

    if (jobIds.length > 0) {
      try {
        await pollGenerateBatch(jobIds, (statuses) => {
          for (const s of statuses) {
            if (s.status === 'COMPLETED') {
              void finalizeCompletedJob(s.jobId);
            } else if (s.status === 'FAILED' || s.status === 'CANCELLED') {
              setItems((prev) =>
                prev.map((p) =>
                  p.jobId === s.jobId && p.status !== 'generated'
                    ? { ...p, status: 'failed', hasError: true, errorMessage: s.errorCode ?? 'Generation failed' }
                    : p,
                ),
              );
            }
          }
        });
      } catch {
        // Timed out — items left mid-flight stay 'generating'; remove & retry.
      }
    }

    setIsGeneratingAll(false);
  };

  const handleApplyGlobalPrice = () => {
    if (!globalActual && !globalOffer) return;
    setItems((prev) =>
      prev.map((item) =>
        item.status === 'generated'
          ? {
              ...item,
              actualPrice: globalActual || item.actualPrice,
              offerPrice: globalOffer || item.offerPrice,
              hasError: false,
            }
          : item,
      ),
    );
  };

  const handleUpdateItem = (id: string, updates: Partial<QueueItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates, hasError: false } : item)));
  };

  const handleRemoveItem = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item) {
      URL.revokeObjectURL(item.fileUrl);
      if (item.status === 'generated' && item.itemId) void deleteProduct(item.itemId);
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleAddCatalogue = async () => {
    let hasValidationError = false;
    const validated = items.map((item) => {
      if (item.status !== 'generated') return item;
      const act = parseInt(item.actualPrice, 10) || 0;
      const off = parseInt(item.offerPrice, 10) || 0;
      const isValid = item.sku.trim() !== '' && item.actualPrice !== '' && item.offerPrice !== '' && off <= act;
      if (!isValid) hasValidationError = true;
      return { ...item, hasError: !isValid };
    });
    setItems(validated);
    if (hasValidationError) return;

    const ready = validated.filter((i): i is QueueItem & { itemId: string } => i.status === 'generated' && !!i.itemId);
    if (ready.length === 0) return;

    setIsSaving(true);
    try {
      await Promise.all(
        ready.map((item) =>
          api.patch(`/v1/merchant/catalog/${item.itemId}`, {
            label: `Product ${item.sku.toUpperCase()}`,
            sku: item.sku.trim(),
            actualPrice: parseInt(item.actualPrice, 10),
            offerPrice: parseInt(item.offerPrice, 10),
          }),
        ),
      );
      qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      goBackToProducts();
    } finally {
      setIsSaving(false);
    }
  };

  const hasQueued = items.some((i) => i.status === 'queued');
  const hasGenerated = items.some((i) => i.status === 'generated');
  const generatedCount = items.filter((i) => i.status === 'generated').length;
  const isAnyGenerating = items.some((i) => i.status === 'uploading' || i.status === 'generating');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader variant="back" title="Bulk Upload" onBack={goBackToProducts} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="hover-surface"
          style={{
            height: 88,
            borderRadius: 8,
            border: `2px dashed ${C.border2}`,
            background: C.field,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            gap: 8,
          }}
        >
          <UploadIcon size={22} />
          <span style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>Tap to choose flat images</span>
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            tabIndex={-1}
          />
        </button>

        {items.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: C.lighter,
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${C.border}`,
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <GradBtn type="button" onClick={handleGenerateAll} disabled={!hasQueued || busy}>
                {isGeneratingAll && <SpinnerIcon size={14} />}
                {isGeneratingAll ? 'Generating…' : 'Generate All'}
              </GradBtn>
              <span style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                {items.length} item{items.length !== 1 && 's'} ({generatedCount} ready)
              </span>
            </div>

            {hasGenerated && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Set price for all:</span>
                <input
                  type="number"
                  placeholder="Actual"
                  value={globalActual}
                  onChange={(e) => setGlobalActual(e.target.value)}
                  style={{ width: 80, height: 32, fontSize: 12, borderRadius: 4, border: `1px solid ${C.border2}`, padding: '0 8px' }}
                />
                <input
                  type="number"
                  placeholder="Offer"
                  value={globalOffer}
                  onChange={(e) => setGlobalOffer(e.target.value)}
                  style={{ width: 80, height: 32, fontSize: 12, borderRadius: 4, border: `1px solid ${C.border2}`, padding: '0 8px' }}
                />
                <button
                  type="button"
                  onClick={handleApplyGlobalPrice}
                  style={{ background: 'none', border: 'none', color: C.pink, fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                border: `1px solid ${item.hasError || item.status === 'failed' ? C.pink : C.border}`,
                borderRadius: 12,
                background: item.hasError || item.status === 'failed' ? 'rgba(245,92,122,0.03)' : C.card,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <button
                type="button"
                onClick={() => handleRemoveItem(item.id)}
                disabled={item.status === 'uploading' || item.status === 'generating'}
                aria-label="Remove item"
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  background: 'rgba(0,0,0,0.5)',
                  color: C.white,
                  border: 'none',
                  borderRadius: 6,
                  width: 28,
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  zIndex: 1,
                }}
              >
                <TrashIcon />
              </button>

              <div style={{ aspectRatio: '3/4', background: C.lighter, position: 'relative' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* biome-ignore lint/performance/noImgElement: local/generated preview */}
                <img src={item.fileUrl} alt="Upload preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                <div style={{ position: 'absolute', bottom: 6, left: 6 }}>
                  {item.status === 'queued' && (
                    <span style={{ background: C.mid, color: C.white, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>
                      Queued
                    </span>
                  )}
                  {(item.status === 'uploading' || item.status === 'generating') && (
                    <span
                      style={{
                        background: C.card,
                        color: C.pink,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 4,
                        textTransform: 'uppercase',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        border: `1px solid ${C.border2}`,
                      }}
                    >
                      <SpinnerIcon size={10} /> {item.status === 'uploading' ? 'Uploading' : 'Generating'}
                    </span>
                  )}
                  {item.status === 'generated' && (
                    <span style={{ background: '#10b981', color: C.white, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>
                      ✓ Generated
                    </span>
                  )}
                  {item.status === 'failed' && (
                    <span style={{ background: C.pink, color: C.white, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>
                      Failed
                    </span>
                  )}
                </div>
              </div>

              {item.status === 'generated' && (
                <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    placeholder="SKU"
                    value={item.sku}
                    onChange={(e) => handleUpdateItem(item.id, { sku: e.target.value })}
                    style={{ width: '100%', height: 32, fontSize: 12, borderRadius: 6, border: `1px solid ${item.hasError && !item.sku ? C.pink : C.border2}`, padding: '0 8px', background: C.field, color: C.text }}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      placeholder="₹ Actual"
                      value={item.actualPrice}
                      onChange={(e) => handleUpdateItem(item.id, { actualPrice: e.target.value })}
                      style={{ width: '100%', height: 32, fontSize: 12, borderRadius: 6, border: `1px solid ${item.hasError && (!item.actualPrice || parseInt(item.offerPrice, 10) > parseInt(item.actualPrice, 10)) ? C.pink : C.border2}`, padding: '0 8px', background: C.field, color: C.text }}
                    />
                    <input
                      type="number"
                      placeholder="₹ Offer"
                      value={item.offerPrice}
                      onChange={(e) => handleUpdateItem(item.id, { offerPrice: e.target.value })}
                      style={{ width: '100%', height: 32, fontSize: 12, borderRadius: 6, border: `1px solid ${item.hasError && (!item.offerPrice || parseInt(item.offerPrice, 10) > parseInt(item.actualPrice, 10)) ? C.pink : C.border2}`, padding: '0 8px', background: C.field, color: C.text }}
                    />
                  </div>
                  {item.hasError && (
                    <div style={{ fontSize: 10, color: C.pink, lineHeight: 1.2 }}>
                      Please fill valid SKU and ensure Offer ≤ Actual Price.
                    </div>
                  )}
                </div>
              )}

              {item.status === 'failed' && item.errorMessage && (
                <div style={{ padding: 10, fontSize: 10, color: C.pink, lineHeight: 1.3 }}>{item.errorMessage}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      <StickyBottomBar>
        <button
          type="button"
          onClick={goBackToProducts}
          disabled={busy}
          style={{
            flex: 1,
            height: 48,
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            background: C.white,
            color: C.text,
            fontFamily: 'inherit',
            fontSize: 15,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
        <div style={{ flex: 1 }}>
          <GradBtn
            type="button"
            disabled={generatedCount === 0 || isAnyGenerating || isSaving}
            onClick={() => void handleAddCatalogue()}
            style={{ width: '100%', height: 48 }}
          >
            {isSaving ? 'Saving…' : `Add ${generatedCount} to Catalogue`}
          </GradBtn>
        </div>
      </StickyBottomBar>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/catalogues-web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx"
git commit -m "feat(web): add the mobile-native Bulk Upload full-screen step"
```

---

### Task 15: Full verification pass and progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: all packages pass, including `apps/api` (Task 1's new test file doesn't affect typecheck) and `apps/catalogues-web` (every new/modified file from Tasks 3–14).

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: exit 0. New a11y warnings on the same familiar patterns (`noLabelWithoutControl` on styled `<label>`s, etc.) are pre-existing-style, not new errors — check the count doesn't include any `error` (not just `warning`) severity from the new files.

- [ ] **Step 3: Run the new backend test**

Run (from `apps/api/`): `npx vitest run --config vitest.integration.config.ts test/integration/catalog-app-google-exchange.test.ts test/integration/catalog-app-auth.test.ts test/integration/merchant-me.test.ts test/integration/catalog-app-garment-types.test.ts`
Expected: all pass — confirms Task 1's new gate didn't regress the existing catalog-app auth suite.

- [ ] **Step 4: Production build**

Run: `pnpm --filter @tryme/catalogues-web build`
Expected: build succeeds — this catches any App Router route-conflict issues (e.g., a duplicate route segment) that `tsc --noEmit` alone wouldn't catch.

- [ ] **Step 5: Manual verification (screenshot-driven, as in prior rounds)**

No browser automation is available in this environment. Start both dev servers (`pnpm --filter @tryme/api dev`, `pnpm --filter @tryme/web dev`) and manually verify, ideally on a real device or Chrome's device toolbar at common phone sizes (375×667, 390×844, 412×915):
- Subcategories screen: category tabs scroll, grid renders, FAB doesn't overlap content, tapping a card navigates, back button returns here from Products
- Add Subcategory: form fields, garment-type dropdown opens without clipping, Save navigates back and the new subcategory appears
- Products screen: grid renders, Bulk Upload button reachable, FAB → Add Product
- Add/Edit Product: both image modes, sticky Save button always reachable regardless of keyboard/scroll position (this was the original bug class being fixed)
- Bulk Upload: native photo picker opens (not drag-and-drop), queue grid, per-item pricing, "set price for all"
- Login: username/password path, and the Google button redirecting correctly back to `/tryon-library-app` for a merchant account, and to `/tryon-library-app?error=not_a_merchant` for a non-merchant Google account
- Browser/PWA back button works at every step (this is the main behavioral upgrade from the previous modal-based version)

- [ ] **Step 6: Update `docs/progress.md`**

Add a new dated entry at the top (today's date) summarizing: the mobile-native rebuild (real nested routes, session gate moved to `layout.tsx`, all five desktop-derived files deleted and replaced), the Google OAuth merchant-gate fix, and the manual-verification caveat (no browser automation available).

- [ ] **Step 7: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record the Try On Library mobile-native rebuild"
```

---

## Self-Review

**Spec coverage:** Every section of `docs/superpowers/specs/2026-07-28-tryon-library-mobile-rebuild-design.md` maps to a task — route architecture (Tasks 7–14), session gate relocation (Task 7), screen-by-screen layout (Tasks 8–14), file plan deletions (Task 3) and creations (Tasks 4–14), visual direction rules (safe-area padding in Task 4, restrained color/typography throughout), and the Google OAuth amendment (Tasks 1–2, added after the spec was written and confirmed with the user).

**Placeholder scan:** No TBD/TODO/"add error handling"-style steps — every step has complete, runnable code or an exact command.

**Type consistency:** `MerchantCatalogItem`, `MerchantCatalogSubcategory`, `MerchantCatalogListResponse`, `MerchantCatalogSubcategoryListResponse`, `MerchantCatalogCategory` are used identically (same field names, same import source `@tryme/types`) across Tasks 8, 10, 11, 12, 13. `ScreenHeader`'s discriminated-union props (`variant: 'root' | 'back'`) are consistent between its Task 4/7 definition and every call site in Tasks 8–14. `catalogAppApi`/`catalog-app-helpers.ts` function signatures (`presignAndUpload`, `pollGenerateJob`, `pollGenerateBatch`, `finalizeGeneratedProduct`, `deleteProduct`) are used with the exact same argument shapes as their existing (unchanged) definitions.
