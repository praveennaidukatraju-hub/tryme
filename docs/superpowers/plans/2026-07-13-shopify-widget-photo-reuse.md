# Shopify Storefront Widget Photo Reuse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a shopper's browser remember their last uploaded photo (per store, 24h) so they can reuse it for a different product's try-on without re-uploading, while "upload a new photo" stays equally available on the same screen.

**Architecture:** Extend the existing Redis ownership marker's TTL from 10 minutes to 24h once a job successfully uses a photo; add one small presigned-GET-URL endpoint for showing a thumbnail of the remembered photo; the storefront widget stores `{ r2Key, uploadedAt }` in `localStorage` and, when valid, offers a "Use this photo" choice above the existing upload picker.

**Tech Stack:** Fastify 5 + Zod (`@tryme/types`) on the backend, vanilla JS/Liquid/CSS in the Shopify theme app extension (no build step, no framework) — matching what's already there.

## Global Constraints

- Reuse window is 24 hours, both server-side (Redis TTL) and client-side (localStorage `uploadedAt` check) — copied verbatim from the approved spec.
- Thumbnail preview must show the actual photo (a real presigned GET URL), not a generic icon.
- A visible "Not you? Remove" control must exist, and it only clears client-side state — no server-side revocation call.
- No new dependencies, build tooling, or test framework — vanilla JS stays vanilla, Fastify integration tests use the existing `vitest` + `startContainers()`/`buildTestApp()` harness.
- Dispatcher/job-processing/credit-billing code is untouched — a reused photo produces a job identical in every way to a fresh upload.

---

### Task 1: Add the preview-request Zod schema

**Files:**
- Modify: `packages/types/src/widget.ts:303-317` (append after `ShopifyCustomerJobRequest`)

**Interfaces:**
- Produces: `ShopifyCustomerPhotoPreviewRequest` (Zod schema + inferred type), consumed by Task 2's new route.

- [ ] **Step 1: Add the schema**

In `packages/types/src/widget.ts`, right after the existing `ShopifyCustomerJobRequest` block (ends at line 317), add:

```ts
export const ShopifyCustomerPhotoPreviewRequest = z.object({
  r2Key: z.string().min(1),
});
export type ShopifyCustomerPhotoPreviewRequest = z.infer<
  typeof ShopifyCustomerPhotoPreviewRequest
>;
```

- [ ] **Step 2: Typecheck and build the package**

Run: `pnpm --filter @tryme/types typecheck`
Expected: no errors.

Run: `pnpm --filter @tryme/types build`
Expected: succeeds, regenerates `packages/types/dist/`. This step is required — `apps/api` imports the compiled `dist/`, not the TypeScript source, so Task 2 will fail to resolve the new export without this build.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/widget.ts packages/types/dist
git commit -m "feat(types): add ShopifyCustomerPhotoPreviewRequest schema"
```

---

### Task 2: Backend — extend ownership TTL and add the preview endpoint

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts:1-99` (import + new route), `:191-193` (TTL extend)
- Test: `apps/api/test/integration/shopify-customer.test.ts`

**Interfaces:**
- Consumes: `ShopifyCustomerPhotoPreviewRequest` from Task 1; existing `app.requireShopifyStoreKey`, `checkRateLimit`, `app.storage.presignGet(key, expiresInSec?)` (returns `{ url, expiresIn }`, from `packages/storage/src/index.ts:12`).
- Produces: `POST /v1/shopify/customer/photo/preview` → `{ previewUrl: string, expiresIn: number }` on success, `404` (`AppError('NOT_FOUND', 404, 'photo not available')`) otherwise. Consumed by Task 4's widget JS.

- [ ] **Step 1: Write the failing integration tests**

Open `apps/api/test/integration/shopify-customer.test.ts`. It already has `seedOwner`, `seedStore`, `seedGarment`, and `uploadCustomerPhoto` helpers (lines 21-82) — reuse them as-is. Add these five `it(...)` blocks right before the file's closing `});` (after the last existing test, currently ending at line 187):

```ts
  it('extends the upload ownership TTL to 24h after a successful job creation', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 11);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 11 },
    });
    expect(res.statusCode).toBe(201);

    const ttl = await app.redis.ttl(`shopify:upload:${r2Key}`);
    expect(ttl).toBeGreaterThan(600);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('reuses the same photo for a second, different product', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 12);
    await seedGarment(store.id, 13);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 12 },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 13 },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { jobId: string }).jobId).not.toBe(
      (first.json() as { jobId: string }).jobId,
    );
  });

  it('returns a presigned preview URL for a photo owned by this store', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/photo/preview',
      headers: { 'x-widget-key': store.storeKey },
      payload: { r2Key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { previewUrl: string };
    expect(body.previewUrl).toContain(r2Key);
  });

  it('rejects a preview request for a photo belonging to a different store', async () => {
    const store = await seedStore(null);
    const otherStore = await seedStore(null);
    const r2Key = await uploadCustomerPhoto(otherStore.storeKey, Buffer.from('photo-bytes'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/photo/preview',
      headers: { 'x-widget-key': store.storeKey },
      payload: { r2Key },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a preview request once the ownership marker has expired', async () => {
    const store = await seedStore(null);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await app.redis.del(`shopify:upload:${r2Key}`);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/photo/preview',
      headers: { 'x-widget-key': store.storeKey },
      payload: { r2Key },
    });
    expect(res.statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run --config ../../vitest.config.ts test/integration/shopify-customer.test.ts` — if that config path doesn't resolve, instead write a temporary override config as done earlier this session:

```bash
cat > /tmp/vitest.integration.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/integration/shopify-customer.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
EOF
cd apps/api && npx vitest run --config /tmp/vitest.integration.config.ts
```

Expected: the 5 new tests FAIL — the TTL-extend test sees `ttl` still `<= 600` (or `-2`, key gone), and the three `photo/preview` tests get `404` from Fastify's own "route not found" (not the app's `AppError` 404) since the route doesn't exist yet. Requires `pnpm docker:up` running (Postgres/Redis/MinIO), same as every other integration test in this repo.

- [ ] **Step 3: Implement the TTL extend**

In `apps/api/src/modules/shopify/customer.routes.ts`, find (around line 191):

```ts
        await atomicDeduct(tx as never, userId, jobCost, jobId);
      });

      await app.redis.xadd(
```

Replace with:

```ts
        await atomicDeduct(tx as never, userId, jobCost, jobId);
      });

      // Extends the presign-time ownership marker (originally EX 600, matching the
      // presigned URL's own expiry) to 24h now that the photo has proven itself real
      // and usable — this is what lets a returning shopper reuse it for a different
      // product without re-uploading. Idempotent: re-extends on every reuse too.
      await app.redis.set(`shopify:upload:${customerPhotoKey}`, storeId, 'EX', 86400);

      await app.redis.xadd(
```

- [ ] **Step 4: Implement the preview endpoint**

In `apps/api/src/modules/shopify/customer.routes.ts`, add the import:

```ts
import {
  ShopifyCustomerJobRequest,
  ShopifyCustomerPhotoPreviewRequest,
  ShopifyCustomerPresignRequest,
} from '@tryme/types';
```

(replacing the current single-line `import { ShopifyCustomerJobRequest, ShopifyCustomerPresignRequest } from '@tryme/types';` at line 3).

Then add the new route right after the existing `/v1/shopify/customer/presign` route (after its closing `);` at line 99, before `app.post('/v1/shopify/customer/jobs', ...)`):

```ts
  app.post(
    '/v1/shopify/customer/photo/preview',
    {
      preHandler: [
        app.requireShopifyStoreKey,
        async (req, reply) => checkRateLimit(app.redis, req.shopifyStoreId as string, reply),
      ],
      schema: { body: ShopifyCustomerPhotoPreviewRequest },
    },
    async (req) => {
      const storeId = req.shopifyStoreId as string;
      const { r2Key } = req.body as ShopifyCustomerPhotoPreviewRequest;

      // Same two checks that gate reuse in /v1/shopify/customer/jobs — one
      // source of truth for "is this photo still reusable."
      if (!r2Key.startsWith(`shopify-inputs/${storeId}/`)) {
        throw new AppError('NOT_FOUND', 404, 'photo not available');
      }
      const owner = await app.redis.get(`shopify:upload:${r2Key}`);
      if (owner !== storeId) {
        throw new AppError('NOT_FOUND', 404, 'photo not available');
      }

      const { url, expiresIn } = await app.storage.presignGet(r2Key, 300);
      return { previewUrl: url, expiresIn };
    },
  );

```

- [ ] **Step 5: Run the tests to verify they pass**

Run the same command as Step 2.
Expected: all 5 new tests PASS, and the file's existing tests (the ones from before this plan) still pass too.

- [ ] **Step 6: Full check**

Run: `pnpm --filter @tryme/api typecheck` — expect clean.
Run: `pnpm --filter @tryme/api lint` — expect clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "feat(api): extend photo ownership to 24h, add reuse preview endpoint"
```

---

### Task 3: Storefront widget markup and styles for the reuse panel

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid:38-47`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css` (append)

**Interfaces:**
- Produces: DOM elements with classes `.tryme-tryon__reuse-panel`, `.tryme-tryon__reuse-thumb`, `.tryme-tryon__reuse-use`, `.tryme-tryon__reuse-remove`, `.tryme-tryon__upload-label-text`, `.tryme-tryon__reuse-expired-note` — all consumed by Task 4's JS via `querySelector`.

- [ ] **Step 1: Update the upload step markup**

In `tryon-block.liquid`, replace the existing upload step (lines 38-47):

```html
          <div class="tryme-tryon__step tryme-tryon__step--upload">
            <label class="tryme-tryon__upload-btn">
              <img class="tryme-tryon__upload-preview" hidden alt="" />
              <span class="tryme-tryon__upload-placeholder">
                <svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>
                <span>Drag and drop photo, or choose file</span>
              </span>
              <input type="file" accept="image/*" class="tryme-tryon__file-input" />
            </label>
          </div>
```

with:

```html
          <div class="tryme-tryon__step tryme-tryon__step--upload">
            <div class="tryme-tryon__reuse-panel" hidden>
              <div class="tryme-tryon__reuse-info">
                <img class="tryme-tryon__reuse-thumb" alt="" />
                <button type="button" class="tryme-tryon__reuse-use">Use this photo</button>
              </div>
              <button type="button" class="tryme-tryon__reuse-remove">Not you? Remove</button>
            </div>
            <p class="tryme-tryon__reuse-expired-note" hidden>
              Your previous photo expired — please upload a new one.
            </p>
            <label class="tryme-tryon__upload-btn">
              <img class="tryme-tryon__upload-preview" hidden alt="" />
              <span class="tryme-tryon__upload-placeholder">
                <svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>
                <span class="tryme-tryon__upload-label-text">Drag and drop photo, or choose file</span>
              </span>
              <input type="file" accept="image/*" class="tryme-tryon__file-input" />
            </label>
          </div>
```

- [ ] **Step 2: Add the CSS**

Append to `tryon-widget.css` (after the last rule, `.tryme-tryon__button`):

```css

.tryme-tryon__reuse-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 19px;
}

.tryme-tryon__reuse-panel[hidden] {
  display: none;
}

.tryme-tryon__reuse-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tryme-tryon__reuse-thumb {
  width: 48px;
  height: 48px;
  border-radius: var(--tryme-border-radius, 4px);
  object-fit: cover;
  flex-shrink: 0;
  background: #f2f2f2;
}

.tryme-tryon__reuse-use {
  flex: 1;
  background: var(--tryme-button-color, #000000);
  color: var(--tryme-text-color, #ffffff);
  border: none;
  border-radius: var(--tryme-border-radius, 4px);
  padding: 10px 16px;
  font-size: 15px;
  cursor: pointer;
}

.tryme-tryon__reuse-remove {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0;
  font-size: 13px;
  color: #666;
  text-decoration: underline;
  cursor: pointer;
}

.tryme-tryon__reuse-expired-note {
  margin: 0 0 10px;
  font-size: 13px;
  color: #a94442;
}

.tryme-tryon__reuse-expired-note[hidden] {
  display: none;
}
```

- [ ] **Step 3: Manually verify the markup renders**

Since this is Liquid (no local template renderer in this repo), this step is verified together with Task 4's manual test (Task 5) once the JS actually toggles `hidden` — skip a standalone render check here.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css
git commit -m "feat(shopify-widget): add reuse-panel markup and styles"
```

---

### Task 4: Storefront widget JS — remember, reuse, and fall back

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`

**Interfaces:**
- Consumes: `POST /v1/shopify/customer/photo/preview` (Task 2) → `{ previewUrl }`; DOM classes from Task 3.
- Produces: `proceedWithPhoto(customerPhotoKey, isReuse)` — the shared job-creation/poll/render path used by both the fresh-upload and reuse flows.

- [ ] **Step 1: Add constants and DOM references**

In `initWidget(root)`, right after the existing `const resultImage = ...` line (line 24), add:

```js
    const reusePanel = root.querySelector('.tryme-tryon__reuse-panel');
    const reuseThumb = root.querySelector('.tryme-tryon__reuse-thumb');
    const reuseUseBtn = root.querySelector('.tryme-tryon__reuse-use');
    const reuseRemoveBtn = root.querySelector('.tryme-tryon__reuse-remove');
    const reuseExpiredNote = root.querySelector('.tryme-tryon__reuse-expired-note');
    const uploadLabelText = root.querySelector('.tryme-tryon__upload-label-text');
    const REUSE_STORAGE_KEY = 'tryme_last_photo';
    const REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 2: Add remember/forget/show/hide helpers**

Right after the block from Step 1, add:

```js
    function getRememberedPhoto() {
      let raw;
      try {
        raw = localStorage.getItem(REUSE_STORAGE_KEY);
      } catch (_err) {
        return null;
      }
      if (!raw) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_err) {
        return null;
      }
      if (!parsed || typeof parsed.r2Key !== 'string' || typeof parsed.uploadedAt !== 'number') {
        return null;
      }
      if (Date.now() - parsed.uploadedAt > REUSE_MAX_AGE_MS) return null;
      return { r2Key: parsed.r2Key };
    }

    function rememberPhoto(r2Key) {
      try {
        localStorage.setItem(REUSE_STORAGE_KEY, JSON.stringify({ r2Key, uploadedAt: Date.now() }));
      } catch (_err) {
        /* private-browsing / storage-full — reuse just won't be offered next time */
      }
    }

    function hideReusePanel() {
      if (reusePanel) reusePanel.hidden = true;
      if (uploadLabelText) uploadLabelText.textContent = 'Drag and drop photo, or choose file';
    }

    function showReusePanel(previewUrl) {
      if (!reusePanel || !reuseThumb) return;
      reuseThumb.src = previewUrl;
      reusePanel.hidden = false;
      if (uploadLabelText) uploadLabelText.textContent = 'Or upload a new photo';
    }

    function forgetPhoto() {
      try {
        localStorage.removeItem(REUSE_STORAGE_KEY);
      } catch (_err) {
        /* ignore */
      }
      hideReusePanel();
    }
```

- [ ] **Step 3: Add the preview-fetch function and wire it into `openModal`**

Add, after the helpers from Step 2:

```js
    async function tryShowReusePanel() {
      const remembered = getRememberedPhoto();
      if (!remembered) {
        hideReusePanel();
        return;
      }
      try {
        const res = await fetch(`${apiBase}/v1/shopify/customer/photo/preview`, {
          method: 'POST',
          headers: { 'x-widget-key': widgetKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ r2Key: remembered.r2Key }),
        });
        if (!res.ok) {
          forgetPhoto();
          return;
        }
        const body = await res.json();
        showReusePanel(body.previewUrl);
      } catch (_err) {
        hideReusePanel();
      }
    }
```

Then find the existing `openModal` function:

```js
    function openModal() {
      modal.hidden = false;
      showStep('upload');
      fileInput.value = '';
      resetUploadPreview();
    }
```

Replace with:

```js
    function openModal() {
      modal.hidden = false;
      showStep('upload');
      fileInput.value = '';
      resetUploadPreview();
      if (reuseExpiredNote) reuseExpiredNote.hidden = true;
      tryShowReusePanel();
    }
```

- [ ] **Step 4: Extract `proceedWithPhoto` and handle the expired-reuse case**

Find the existing `createJob` function and replace its body's status handling — specifically, add a `403` branch. Current:

```js
    async function createJob(customerPhotoKey) {
      const res = await fetch(`${apiBase}/v1/shopify/customer/jobs`, {
        method: 'POST',
        headers: {
          'x-widget-key': widgetKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shopifyProductId: productId, customerPhotoKey: customerPhotoKey }),
      });
      if (res.status === 402) {
        showStep('error');
        const errorStep = steps.error;
        if (errorStep) {
          errorStep.querySelector('p').textContent =
            'Try-on is temporarily unavailable, please check back later.';
        }
        throw new Error('try-on unavailable');
      }
      if (res.status === 202) return { pending: true };
      if (!res.ok) throw new Error(`job create failed: ${res.status}`);
      const body = await res.json();
      return { pending: false, jobId: body.jobId };
    }
```

Replace with:

```js
    async function createJob(customerPhotoKey) {
      const res = await fetch(`${apiBase}/v1/shopify/customer/jobs`, {
        method: 'POST',
        headers: {
          'x-widget-key': widgetKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shopifyProductId: productId, customerPhotoKey: customerPhotoKey }),
      });
      if (res.status === 402) {
        showStep('error');
        const errorStep = steps.error;
        if (errorStep) {
          errorStep.querySelector('p').textContent =
            'Try-on is temporarily unavailable, please check back later.';
        }
        throw new Error('try-on unavailable');
      }
      if (res.status === 403) {
        const err = new Error('upload session expired or not owned');
        err.expiredReuse = true;
        throw err;
      }
      if (res.status === 202) return { pending: true };
      if (!res.ok) throw new Error(`job create failed: ${res.status}`);
      const body = await res.json();
      return { pending: false, jobId: body.jobId };
    }
```

Then find `handleFile`:

```js
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
        const resultUrl = await waitForResult(jobResult.jobId);
        resultImage.src = resultUrl;
        showStep('result');
      } catch (_err) {
        showStep('error');
      }
    }
```

Replace with (this extracts the shared post-upload logic into `proceedWithPhoto`, used by both the fresh-upload path below and the reuse path in Step 5):

```js
    async function proceedWithPhoto(customerPhotoKey, isReuse) {
      try {
        rememberPhoto(customerPhotoKey);
        const jobResult = await createJob(customerPhotoKey);
        if (jobResult.pending) {
          showStep('pending');
          return;
        }
        const resultUrl = await waitForResult(jobResult.jobId);
        resultImage.src = resultUrl;
        showStep('result');
      } catch (err) {
        if (isReuse && err && err.expiredReuse) {
          forgetPhoto();
          showStep('upload');
          if (reuseExpiredNote) reuseExpiredNote.hidden = false;
          return;
        }
        showStep('error');
      }
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
        await proceedWithPhoto(customerPhotoKey, false);
      } catch (_err) {
        showStep('error');
      }
    }
```

- [ ] **Step 5: Wire the reuse and remove buttons**

Find the existing event-listener block near the bottom of `initWidget`:

```js
    button.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
```

Add right after it (still inside `initWidget`, before the `fileInput.addEventListener(...)` block):

```js
    if (reuseUseBtn) {
      reuseUseBtn.addEventListener('click', () => {
        const remembered = getRememberedPhoto();
        if (!remembered) {
          hideReusePanel();
          return;
        }
        showStep('progress');
        proceedWithPhoto(remembered.r2Key, true);
      });
    }
    if (reuseRemoveBtn) {
      reuseRemoveBtn.addEventListener('click', forgetPhoto);
    }
```

- [ ] **Step 6: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js
git commit -m "feat(shopify-widget): remember and reuse the last uploaded photo"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Deploy the dev app**

From `apps/shopify-extension`: `npx shopify app deploy --config dev --allow-updates` (same command used earlier this session). Confirm it reports success and lists the theme extension as updated.

- [ ] **Step 2: First upload, confirm it's remembered**

On the storefront (via the dev tunnel), open the widget on Product A, upload a photo, wait for the result. Then reopen the widget on Product A again (or navigate to Product B) — confirm the reuse panel now appears with a visible thumbnail matching the uploaded photo, and the file-picker label now reads "Or upload a new photo".

- [ ] **Step 3: Confirm reuse creates a job**

Click "Use this photo." Confirm a new job is created and completes, without any new file-upload network request happening (check browser Network tab — there should be no `PUT` to a MinIO/R2 presigned URL for this click, only the `photo/preview` and `jobs` calls).

- [ ] **Step 4: Confirm the TTL extended in Redis**

```bash
docker exec tryme-redis redis-cli TTL "shopify:upload:<the r2Key from step 2>"
```
Expected: a value greater than 600 (should be close to 86400 minus elapsed time).

- [ ] **Step 5: Confirm "Not you? Remove" works**

Click "Not you? Remove." Confirm the reuse panel disappears and the file-picker label reverts to "Drag and drop photo, or choose file". Reopen the modal — confirm the reuse panel does not reappear (localStorage entry is gone).

- [ ] **Step 6: Confirm the expired-reuse fallback**

Upload a fresh photo again (to have a remembered key), then manually delete its Redis key to simulate expiry:
```bash
docker exec tryme-redis redis-cli DEL "shopify:upload:<the r2Key>"
```
Reopen the widget — the reuse panel still shows (client-side localStorage doesn't know about the server-side deletion). Click "Use this photo." Confirm it falls back to the plain upload view with the "Your previous photo expired" note visible, instead of the generic error step.

- [ ] **Step 7: Update progress log**

Per this repo's `CLAUDE.md` convention, add a dated entry to `docs/progress.md` noting this feature shipped, once all manual checks above pass.
