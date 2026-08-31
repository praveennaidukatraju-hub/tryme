# Merchant Logo on Android Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a logo image for a merchant; the single Android app (used both as an in-store kiosk and as a merchant staff member's own phone — there is no separate kiosk backend) receives that merchant's logo URL in its existing login response, falling back to its own bundled default when no logo has been uploaded.

**Architecture:** Add a nullable `logoKey` column to `merchants`. Admin uploads it through the existing "Edit merchant" modal in admin-web using the same presigned-PUT pattern already used for every other admin image upload in this codebase. `POST /v1/auth/device-login` — the only endpoint the Android app authenticates through — gains one new response field, `logoUrl: string | null`, resolved from that column. `/v1/kiosk/auth/*` and `/v1/auth/device-refresh` are explicitly untouched (confirmed out of scope during design).

**Tech Stack:** Fastify 5 + Zod (`@tryme/types`), Drizzle ORM (`packages/db`), R2 storage (`@tryme/storage`), React (admin-web Vite SPA), Vitest integration tests against real Postgres/Redis.

**Design reference:** `docs/superpowers/specs/2026-07-27-merchant-logo-android-login-design.md` — read it first for the full rationale (why `logoUrl: null` means "use your bundled default" rather than the API always returning some URL, why only `device-login` and not `device-refresh` or the kiosk-pairing endpoints are touched).

---

### Task 1: Schema — `merchants.logoKey` column + storage key builder

**Files:**
- Modify: `packages/db/src/schema/merchant.ts`
- Modify: `packages/storage/src/keys.ts`

- [ ] **Step 1: Add the column**

In `packages/db/src/schema/merchant.ts`, the `merchants` table (lines 16–35) currently ends:
```ts
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  // Login credentials live on `users` — a merchant IS a user with a merchants
  // profile attached (same pattern as admin_users). One merchant account per user.
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```
Add `logoKey` right after `webhookSecret`:
```ts
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  // Nullable -- R2 object key for the merchant's uploaded logo, shown by the
  // Android app (kiosk + mobile, same app, same login) in place of its bundled
  // Tryme default. Null means "no merchant logo, app uses its own default" --
  // see /v1/auth/device-login's logoUrl field in apps/api/src/modules/auth/routes.ts.
  logoKey: text('logo_key'),
  // Login credentials live on `users` — a merchant IS a user with a merchants
  // profile attached (same pattern as admin_users). One merchant account per user.
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add the R2 key builder**

In `packages/storage/src/keys.ts`, add this entry to the `keys` object (anywhere among the other single-purpose builders, e.g. right after `merchantCatalogFlatGarment`):
```ts
  merchantLogo: (merchantId: string) => `merchant-logo/${merchantId}/logo.jpg`,
```

- [ ] **Step 3: Generate and apply the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/0127_<generated-name>.sql` containing:
```sql
ALTER TABLE "merchants" ADD COLUMN "logo_key" text;
```
If it fails with a snapshot-collision error, follow `CLAUDE.md`'s "Migration Index Conflicts" procedure (the same manual-snapshot approach used for `0125_add_user_defaults.sql` and `0126_add_username_login.sql`).

Run: `pnpm db:migrate`
Expected: `Applied 0127_<name>` with no errors.

- [ ] **Step 4: Verify**

Run:
```bash
cd apps/api && node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
sql\`SELECT column_name FROM information_schema.columns WHERE table_name='merchants' AND column_name='logo_key'\`.then(r => { console.log(r); return sql.end(); });
"
```
Expected: one row, `{ column_name: 'logo_key' }`.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @tryme/db exec tsc --noEmit && pnpm --filter @tryme/storage exec tsc --noEmit`
Expected: no output.

```bash
git add packages/db/src/schema/merchant.ts packages/storage/src/keys.ts packages/db/src/migrations/0127_*.sql packages/db/src/migrations/meta/0127_snapshot.json packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add merchants.logoKey column"
```

---

### Task 2: Types — `AdminMerchantUpdateBody` accepts `logoKey`

**Files:**
- Modify: `packages/types/src/widget.ts`

- [ ] **Step 1: Add the field**

Current (lines 371–384):
```ts
export const AdminMerchantUpdateBody = z
  .object({
    isActive: z.boolean().optional(),
    companyName: z.string().min(1).max(160).optional(),
    contactName: z.string().min(1).max(120).optional(),
    phone: z.string().min(1).max(40).optional(),
    businessAddress: z.string().min(1).optional(),
    webhookUrl: z.string().url().nullable().optional(),
    webhookSecret: z.string().max(512).nullable().optional(),
    kioskEnabled: z.boolean().optional(),
    maxKioskDevices: z.number().int().min(1).max(100).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
```
Add `logoKey` to the object (right after `maxKioskDevices`):
```ts
export const AdminMerchantUpdateBody = z
  .object({
    isActive: z.boolean().optional(),
    companyName: z.string().min(1).max(160).optional(),
    contactName: z.string().min(1).max(120).optional(),
    phone: z.string().min(1).max(40).optional(),
    businessAddress: z.string().min(1).optional(),
    webhookUrl: z.string().url().nullable().optional(),
    webhookSecret: z.string().max(512).nullable().optional(),
    kioskEnabled: z.boolean().optional(),
    maxKioskDevices: z.number().int().min(1).max(100).optional(),
    logoKey: z.string().max(500).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
```
(The `.refine(...)` call and everything after it is unchanged — adding one more optional field doesn't affect that check.)

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm --filter @tryme/types exec tsc --noEmit`
Expected: no output.

```bash
git add packages/types/src/widget.ts
git commit -m "feat(types): accept logoKey in AdminMerchantUpdateBody"
```

---

### Task 3: Backend — admin presign route + persist `logoKey`

**Files:**
- Modify: `apps/api/src/modules/admin/merchants.routes.ts`
- Test: `apps/api/test/integration/admin-merchant-logo.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/admin-merchant-logo.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('admin merchant logo upload', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('presigns an upload URL keyed to the merchant', async () => {
    const { merchantId } = await createTestMerchant(app);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantId}/logo/presign`,
      headers: authHeader,
      payload: { contentType: 'image/png' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { uploadUrl: string; logoKey: string };
    expect(body.uploadUrl).toBeTruthy();
    expect(body.logoKey).toBe(`merchant-logo/${merchantId}/logo.jpg`);
  });

  it('persists logoKey via the existing PATCH route, and null clears it', async () => {
    const { merchantId } = await createTestMerchant(app);

    const setRes = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: authHeader,
      payload: { logoKey: `merchant-logo/${merchantId}/logo.jpg` },
    });
    expect(setRes.statusCode).toBe(200);

    const [afterSet] = await app.db
      .select({ logoKey: schema.merchants.logoKey })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));
    expect(afterSet?.logoKey).toBe(`merchant-logo/${merchantId}/logo.jpg`);

    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: authHeader,
      payload: { logoKey: null },
    });
    expect(clearRes.statusCode).toBe(200);

    const [afterClear] = await app.db
      .select({ logoKey: schema.merchants.logoKey })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));
    expect(afterClear?.logoKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-merchant-logo
```
Expected: FAIL — `/admin/merchants/:id/logo/presign` doesn't exist (404); the PATCH test may also fail since `logoKey` isn't in `AdminMerchantUpdateBody`'s handling yet (it'll be silently ignored, so `afterSet?.logoKey` stays `null` and the assertion fails).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/admin/merchants.routes.ts`, add `keys` to the imports (currently line 1):
```ts
import { schema } from '@tryme/db';
```
becomes:
```ts
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
```

In the `PATCH /admin/merchants/:id` handler (currently lines 296–314), the `updates` block currently ends:
```ts
      if (body.webhookSecret !== undefined) {
        updates.webhookSecret = body.webhookSecret || null;
      }
```
Add, right after that block:
```ts
      if (body.logoKey !== undefined) {
        updates.logoKey = body.logoKey;
      }
```

Add the new presign route directly after the `PATCH /admin/merchants/:id` route's closing `);` (currently line 325), before the `POST /admin/merchants/:id/credits` route (currently line 327):
```ts
  app.post(
    '/admin/merchants/:id/logo/presign',
    {
      preHandler: requireAdmin(['SUPER_ADMIN']),
      schema: { body: z.object({ contentType: AssetContentType }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { contentType } = req.body as { contentType: string };
      const logoKey = keys.merchantLogo(id);
      const presign = await app.storage.presignPut(logoKey, contentType, 2_000_000, 300);
      return { uploadUrl: presign.url, logoKey };
    },
  );
```

Add `AssetContentType` to the `@tryme/types` import (currently line 2):
```ts
import { AdminMerchantUpdateBody } from '@tryme/types';
```
becomes:
```ts
import { AdminMerchantUpdateBody, AssetContentType } from '@tryme/types';
```

- [ ] **Step 4: Run the tests again to confirm they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-merchant-logo
```
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/merchants.routes.ts apps/api/test/integration/admin-merchant-logo.test.ts
git commit -m "feat(api): add merchant logo presign route, persist logoKey via existing PATCH"
```

---

### Task 4: Backend — expose logo on the admin merchant detail view

**Files:**
- Modify: `apps/api/src/modules/admin/users.routes.ts`

- [ ] **Step 1: Add `logoKey` to the merchant select**

Current (lines 139–150):
```ts
      const [merchantRow] = await app.db
        .select({
          id: schema.merchants.id,
          companyName: schema.merchants.companyName,
          contactName: schema.merchants.contactName,
          phone: schema.merchants.phone,
          businessAddress: schema.merchants.businessAddress,
          isActive: schema.merchants.isActive,
          kioskEnabled: schema.merchants.kioskEnabled,
          maxKioskDevices: schema.merchants.maxKioskDevices,
          creditBalance: schema.merchantCredits.balance,
        })
```
Add `logoKey: schema.merchants.logoKey,` right after `maxKioskDevices`:
```ts
      const [merchantRow] = await app.db
        .select({
          id: schema.merchants.id,
          companyName: schema.merchants.companyName,
          contactName: schema.merchants.contactName,
          phone: schema.merchants.phone,
          businessAddress: schema.merchants.businessAddress,
          isActive: schema.merchants.isActive,
          kioskEnabled: schema.merchants.kioskEnabled,
          maxKioskDevices: schema.merchants.maxKioskDevices,
          logoKey: schema.merchants.logoKey,
          creditBalance: schema.merchantCredits.balance,
        })
```

- [ ] **Step 2: Resolve it to a `logoUrl` in the response**

Current (lines 175–181):
```ts
      return {
        ...user,
        balance: credits?.balance ?? 0,
        totalJobs: jobsCount?.total ?? 0,
        recentJobs: jobs,
        merchant: merchantRow ?? null,
      };
```
Replace with:
```ts
      return {
        ...user,
        balance: credits?.balance ?? 0,
        totalJobs: jobsCount?.total ?? 0,
        recentJobs: jobs,
        merchant: merchantRow
          ? {
              ...merchantRow,
              logoUrl: merchantRow.logoKey ? app.storage.publicUrl(merchantRow.logoKey) : null,
            }
          : null,
      };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/users.routes.ts
git commit -m "feat(api): expose merchant logoKey/logoUrl on GET /admin/users/:id"
```

---

### Task 5: Backend — deliver `logoUrl` on `/v1/auth/device-login`

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Test: `apps/api/test/integration/device-login-logo.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/device-login-logo.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('device-login logoUrl', () => {
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

  async function setPassword(userId: string, password: string) {
    const passwordHash = await hashPassword(password);
    await app.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
  }

  it('returns the merchant logo URL when one is configured', async () => {
    const { merchantId, userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    await app.db
      .update(schema.merchants)
      .set({ logoKey: `merchant-logo/${merchantId}/logo.jpg` })
      .where(eq(schema.merchants.id, merchantId));
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login',
      payload: {
        email: user?.email,
        password: 'password123',
        deviceId: 'device-1',
        deviceName: 'Test Device',
        platform: 'mobile',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBeTruthy();
  });

  it('returns null when the merchant has no logo configured', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login',
      payload: {
        email: user?.email,
        password: 'password123',
        deviceId: 'device-2',
        deviceName: 'Test Device',
        platform: 'mobile',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts device-login-logo
```
Expected: FAIL — the response has no `logoUrl` field at all, so `expect(...).toBeTruthy()` fails and `expect(...).toBeNull()` fails (it'll be `undefined`, not `null`).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/auth/routes.ts`, add this new local helper function right before `async function issueDeviceSession(` (search for that exact string — it's defined a bit above the device-login route):

```ts
// The Android app (kiosk + merchant staff mobile login — same app, same login,
// no separate kiosk backend) shows this in place of its bundled default logo.
// null means "no merchant logo configured, use your bundled default" -- see
// docs/superpowers/specs/2026-07-27-merchant-logo-android-login-design.md.
async function resolveMerchantLogoUrl(app: FastifyInstance, userId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ logoKey: schema.merchants.logoKey })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, userId));
  return row?.logoKey ? app.storage.publicUrl(row.logoKey) : null;
}
```

In the `/v1/auth/device-login` handler, current final line (currently line 726):
```ts
      return { ...tokens, user: deviceLoginUserPayload(user) };
```
Replace with:
```ts
      const logoUrl = await resolveMerchantLogoUrl(app, user.id);
      return { ...tokens, user: deviceLoginUserPayload(user), logoUrl };
```

- [ ] **Step 4: Run the tests again to confirm they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts device-login-logo
```
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/integration/device-login-logo.test.ts
git commit -m "feat(api): deliver merchant logoUrl on /v1/auth/device-login"
```

---

### Task 6: Frontend admin-web — upload control in the Edit Merchant modal

**Files:**
- Modify: `apps/admin-web/src/types.ts`
- Modify: `apps/admin-web/src/pages/UsersPage.tsx`

- [ ] **Step 1: Update `UserMerchant` type**

Current (`apps/admin-web/src/types.ts` lines 189–199):
```ts
export interface UserMerchant {
  id: string;
  companyName: string;
  contactName: string;
  phone: string;
  businessAddress: string;
  isActive: boolean;
  kioskEnabled: boolean;
  maxKioskDevices: number;
  creditBalance: number | null;
}
```
Add `logoKey`/`logoUrl` right after `maxKioskDevices`:
```ts
export interface UserMerchant {
  id: string;
  companyName: string;
  contactName: string;
  phone: string;
  businessAddress: string;
  isActive: boolean;
  kioskEnabled: boolean;
  maxKioskDevices: number;
  logoKey: string | null;
  logoUrl: string | null;
  creditBalance: number | null;
}
```

- [ ] **Step 2: Add upload state**

Near the other merchant-edit state declarations in `apps/admin-web/src/pages/UsersPage.tsx` (currently lines 91–92):
```ts
  const [showEditMerchant, setShowEditMerchant] = useState(false);
  const [merchantEditForm, setMerchantEditForm] = useState(EMPTY_EDIT_MERCHANT_FORM);
```
Add right after:
```ts
  const [uploadingLogo, setUploadingLogo] = useState(false);
```

- [ ] **Step 3: Add the upload handler**

Right after the existing `handleMerchantEditSave` function (currently ending around line 395 with its closing `}`), add:

```ts
  async function handleLogoUpload(file: File) {
    if (!detail?.merchant) return;
    setUploadingLogo(true);
    try {
      const presign = await apiFetch<{ uploadUrl: string; logoKey: string }>(
        `/admin/merchants/${detail.merchant.id}/logo/presign`,
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      await apiFetch(`/admin/merchants/${detail.merchant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ logoKey: presign.logoKey }),
      });
      toast({ title: 'Merchant logo updated' });
      await openDetail(detail);
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to upload logo') });
    } finally {
      setUploadingLogo(false);
    }
  }
```

`apiFetch<T = unknown>(path, init)` (`apps/admin-web/src/lib/data.ts:534`) already supports the generic form used above — no adjustment needed.

- [ ] **Step 4: Add the upload control to the Edit Merchant modal**

In the `showEditMerchant` modal (currently lines 1109–1172), add a logo field as the first field in `modal-body`, right after the opening of that div (currently line 1118, right before the "Company name" field block):

```tsx
                <div className="field">
                  <label>Logo</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {detail.merchant?.logoUrl && (
                      // biome-ignore lint/performance/noImgElement: admin SPA, not Next.js
                      <img
                        src={detail.merchant.logoUrl}
                        alt="Merchant logo"
                        style={{
                          width: 48,
                          height: 48,
                          objectFit: 'contain',
                          borderRadius: 6,
                          border: '1px solid var(--border)',
                        }}
                      />
                    )}
                    <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
                      {uploadingLogo ? 'Uploading…' : 'Upload logo'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        style={{ display: 'none' }}
                        disabled={uploadingLogo}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleLogoUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
```

- [ ] **Step 5: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: builds cleanly (same pre-existing chunk-size warning as always).

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/UsersPage.tsx
git commit -m "feat(admin): upload a merchant logo from the Edit Merchant modal"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full workspace typecheck**

Run: `pnpm typecheck`
Expected: clean across every package.

- [ ] **Step 2: Run every new/modified integration test together**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-merchant-logo device-login-logo
```
Expected: all PASS (4 tests).

- [ ] **Step 3: Admin build**

Run: `pnpm --filter @tryme/admin build`
Expected: builds cleanly.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: exit 0 on every file this plan touched (pre-existing unrelated warnings elsewhere in the repo are fine — do not "fix" files this plan didn't change).

- [ ] **Step 5: Update `docs/progress.md`**

Add a new dated entry at the top: what was built (merchant logo column, admin upload flow, `device-login` now returns `logoUrl`), what's verified, and note in "Failed / Not Done" that no live browser click-through was performed (state whether one was possible in your environment) and that the actual Android app integration itself is out of scope for this repo — this plan only produces the backend contract and the admin upload UI.

- [ ] **Step 6: Write the API contract handoff note**

Copy the "API contract to hand off to the Android developer" section verbatim from `docs/superpowers/specs/2026-07-27-merchant-logo-android-login-design.md` into your final report to the user — that's the exact text meant to be shared with the Android developer.

- [ ] **Step 7: Do not commit or push beyond the per-task commits above**

Per this repo's standing convention (`CLAUDE.md` "Git Commit & Push Policy"), do not `git push` or open a PR unless explicitly asked to in a later message.
