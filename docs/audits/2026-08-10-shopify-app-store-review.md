# Shopify App Store review — compliance audit

- **Date:** 2026-08-10
- **App:** Ai Vastra: Virtual Try-On (`client_id` `771a0258b180063d6015e4f5f8f1f586`)
- **Status:** Paused by Shopify review, reference 126765
- **Branch reviewed:** `worktree-shopify-app-store-compliance` @ `710d47e2` (= `dev`)
- **Requirement source:** `shopify doc fetch --url https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements` (fetched 2026-08-10)

Surfaces in scope:

| Surface | Path |
|---|---|
| Embedded admin SPA | `apps/shopify/` |
| App + extension config | `apps/shopify-extension/` |
| Theme app extension | `apps/shopify-extension/extensions/tryon-theme-extension/` |
| Backend Shopify module | `apps/api/src/modules/shopify/` |
| Merchant billing (off-platform) | `apps/api/src/modules/merchant/payments.routes.ts`, `packages/types/src/widget.ts` |

## Summary

| Result | Count |
|---|---|
| ✅ Likely passing | 27 |
| ❌ Likely failing | 4 |
| ⚠️ Needs review | 3 |
| ⏭️ Groups skipped | 9 |

Shopify's pause email cited only **1.2.1**. This audit finds **1.2.2** and **1.2.3** fail for the same root cause, plus one independent failure (**2.2.4**, REST Admin API) that will surface on resubmission if not fixed now.

---

## ❌ Failing

### F1 — 1.2.1 Use Shopify App Pricing or the Shopify Billing API

**Severity:** blocker (cited by Shopify)

**What was found**

No Shopify billing exists anywhere in the repo. Grep for `appSubscriptionCreate`, `appPurchaseOneTimeCreate`, `appUsageRecordCreate`, `currentAppInstallation` across `apps/` and `packages/` returns zero hits.

All app charges run through Razorpay:

| File | Evidence |
|---|---|
| `packages/types/src/widget.ts:35` | `MERCHANT_PLAN_BILLING` — basic ₹25,000 / advanced ₹50,000 / pro ₹75,000 / ultra ₹1,50,000 |
| `apps/api/src/modules/merchant/payments.routes.ts:95` | Razorpay order created from that table; signature-verified credit grant |
| `apps/shopify/src/pages/DashboardPage.tsx:278` | `<Button url="https://app.tryme.com/pricing" target="_blank">Top up on tryme.com</Button>` — off-platform checkout link inside the embedded app |
| `apps/shopify/src/components/LinkAccountGate.tsx:67` | Install-screen copy: *"Billing and credits live on app.tryme.com — nothing is charged through Shopify."* |
| `apps/api/src/modules/shopify/webhook.routes.ts:154` | `app_subscriptions_update` handler is a no-op `req.log.info` — subscription plumbing was stubbed but never built |

`LinkAccountGate.tsx:67` is the highest-risk line: it states the violation in the merchant-visible UI on the first screen after install, which is almost certainly what the reviewer's screencast captured.

**Why this matters**

Off-platform billing is a hard distribution blocker. It is not waivable, and the listing being marked "Free" while the app UI sells four paid tiers is a second, separate violation of the same requirement.

---

### F2 — 1.2.2 Implement Shopify App Pricing or the Billing API correctly

**Severity:** blocker (consequence of F1)

**What was found**

No charge-approval flow exists, so none of the required behaviours are implemented:

- No handling of a merchant **declining** a charge (no `confirmationUrl` flow, no declined-status branch).
- No **re-approval on reinstall**. `apps/api/src/modules/shopify/auth.routes.ts:56-71` correctly upserts the store and clears `uninstalledAt`, but there is no subscription state to re-request.
- `app_subscriptions/update` is registered as a webhook topic (`webhook.routes.ts:189`) with a handler that logs and returns — no state is persisted.

---

### F3 — 1.2.3 Allow pricing plan changes

**Severity:** blocker (consequence of F1)

**What was found**

Plan changes are only possible on `app.tryme.com`, reached via the external link at `DashboardPage.tsx:278`. There is no in-app upgrade/downgrade path, and no plan state is read from Shopify. Charges will never appear in the merchant's Shopify application charge history.

---

### F4 — 2.2.4 Use the GraphQL Admin API

**Severity:** blocker on resubmission — **not** cited by Shopify yet, but independently disqualifying for a new public app

**What was found**

`apps/api/src/modules/shopify/webhook.routes.ts:195` registers webhooks over the **REST Admin API**:

```ts
const res = await shopifyAdminFetch(shop, token, '/webhooks.json', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
});
```

Topics affected: `app/uninstalled`, `app_subscriptions/update`, `products/update`, `products/delete`.

All *other* Admin API traffic is already GraphQL (`apps/api/src/modules/shopify/service.ts:127` posts to `/graphql.json`); this is the only REST call site. The Theme/Asset API exemption does not cover webhook registration.

**Fix direction:** either declare the four topics declaratively in `apps/shopify-extension/shopify.app.toml` under `[webhooks]` (preferred — removes the per-install call entirely), or switch to the `webhookSubscriptionCreate` GraphQL mutation.

---

## ⚠️ Needs review

### R1 — 1.1.8 Build apps for Shopify POS only, not third-party systems

**Why this needs attention**

`apps/api/src/modules/kiosk/` implements a device-registered, customer-facing in-store try-on kiosk (`kiosk_devices` table, `/v1/kiosk/*` routes). It is TryMe's own retail surface, not a sync integration with Square/Clover/Lightspeed, and it is not reachable from the Shopify app or the theme extension.

**What to verify:** that no Shopify-facing listing copy, screenshot, or in-app text describes the kiosk as a POS integration. If the kiosk is positioned as a POS feature of the Shopify app, this becomes a failure.

---

### R2 — 2.3.2 Authenticate immediately after install

**Why this needs attention**

The app deliberately does **not** run its own OAuth redirect. `apps/shopify-extension/shopify.app.toml` omits `use_legacy_install_flow`, so Shopify performs managed installation and the first authenticated request exchanges the session token for an offline token (`apps/api/src/modules/shopify/token.ts`). `apps/shopify/index.html` documents this and explains that the previous self-initiated OAuth caused 429 throttling during automated review.

This is Shopify's recommended modern flow and satisfies the requirement's intent, but the literal verification guidance looks for a redirect to `/admin/oauth/authorize`.

**What to verify:** managed installation is actually enabled in the Partner Dashboard for this app, and that `application_url` there matches `https://app.tryme.com/shopify-admin/embedded` (the TOML comment records that these two had previously drifted apart).

---

### R3 — 3.1.1 Use a valid TLS/SSL certificate

**Why this needs attention**

`apps/shopify/nginx.conf` listens on plain HTTP port 80; TLS is terminated by an upstream edge proxy not represented in this repo. The CSP `frame-ancestors https://*.myshopify.com https://admin.shopify.com` is correctly set for an embedded app.

**What to verify:** `app.tryme.com` and `admin.tryme.com` both serve a valid, non-expired certificate with no mixed-content or chain warnings, and that plain HTTP redirects to HTTPS at the edge.

---

## ✅ Passing (27)

Recorded for the resubmission trail; no action needed.

| Req | Evidence |
|---|---|
| 1.1.1 session tokens | `apps/shopify/src/lib/appBridge.ts:60` uses `window.shopify.idToken()`; `apps/shopify/src/lib/api.ts` sends a Bearer token, no cookies. `sessionStorage` appears only as a reload-loop marker (`appBridge.ts:78-91`), guarded for storage-blocked contexts |
| 1.1.2 Shopify checkout | Widget adds to cart via native `/cart/add.js` (`tryon-widget.js:340`); no external checkout |
| 1.1.3 no theme downloads | No Theme/Asset API or `themeFilesUpsert` calls anywhere |
| 1.1.4 factual data | Analytics read `shopify_widget_events`; no synthetic sales/review generation |
| 1.1.6 single merchant | No multi-seller or payment-splitting logic |
| 1.1.7 payment gateway | No payment scopes, no Payments API usage |
| 1.1.9 buyer charges | Widget adds only the merchant's own variant; no fees or surcharges |
| 1.1.10 shipping | App does not touch shipping options |
| 1.1.13 authorized products | Syncs only the merchant's own catalog via `products.sync.ts` |
| 1.1.14 no agency marketplace | Support routes to TryMe's own team (`SupportPage.tsx`) |
| 1.1.15 refunds | No Shopify order refunds issued; credit refunds are internal ledger entries |
| 1.1.16 no lending | None |
| 2.2.1 uses Shopify APIs | GraphQL Admin API, session tokens, webhooks |
| 2.2.3 latest App Bridge | `apps/shopify/index.html` loads `https://cdn.shopify.com/shopifycloud/app-bridge.js` as the first script; no legacy `@shopify/app-bridge` package in `apps/shopify/package.json` |
| 2.2.6 no admin-extension promos | No admin UI extensions exist |
| 2.2.7 max modal | No fullscreen/max modal usage |
| 2.3.1 install from Shopify surface | No `.myshopify.com` input field in the SPA |
| 2.3.3 redirect after install | `buildPostInstallRedirect` (`auth.routes.ts`) returns merchants to `admin.shopify.com/store/{handle}/apps/{apiKey}` so Shopify mints `host`/`id_token` |
| 2.3.4 reinstall | `auth.routes.ts:56-71` updates the existing store row and clears `uninstalledAt`; no install-once flags |
| 3.2.1–3.2.5 scopes | `shopify.app.toml` requests only `read_products,write_products`; none of the restricted scopes |
| 5.1.1 theme app extension | App block `blocks/tryon-button.liquid` (`target: "section"`); no ScriptTag or Asset API |
| 5.1.3 onboarding + deep link | `DashboardPage.tsx:195-227` step-by-step activation with an **Open theme editor** button backed by `GET /v1/shopify/onboarding/theme-editor-url` → `buildThemeEditorDeepLink` |
| 5.1.5 data back to merchant | Settings → Data tab lists shoppers (`/v1/shopify/shoppers`) with CSV export (`SettingsPage.tsx:133-156`) |

---

## ⏭️ Groups skipped

| Group | Reason |
|---|---|
| 5.2 Payment | No extension of `type = "payment"`; no `write_payment_gateway` scope |
| 5.3 Payment facilitator | Opt-in only |
| 5.4 Purchase option | No `read/write_customer_payment_methods`, `read/write_own_subscription_contracts`, or `read/write_payment_mandate` scopes |
| 5.5 Product sourcing | Opt-in only |
| 5.6 Checkout customization | No checkout `ui-extension` targets |
| 5.7 Sales channel | No `channel_config` extension |
| 5.8 Post purchase | No `checkout_post_purchase` extension |
| 5.9 Mobile app builders | Opt-in only |
| 5.10 Donation | Opt-in only |

Only `type = "theme"` is declared (`apps/shopify-extension/extensions/tryon-theme-extension/shopify.extension.toml:2`), so Group 5.1 was the sole category group evaluated.

---

## Remediation plan

Recommended split: **Shopify Managed Pricing** for recurring plans (zero backend code, handles upgrade/downgrade/decline/reinstall for free — closes F2 and F3 outright) plus the **Billing API** `appPurchaseOneTimeCreate` for one-time credit top-ups, which Managed Pricing does not cover.

### Phase 1 — billing (closes F1, F2, F3)

1. Define the four plans in Partner Dashboard → App pricing (Managed Pricing). Requires USD price points; `MERCHANT_PLAN_BILLING` is INR-only today.
2. Read plan state server-side via Admin GraphQL `currentAppInstallation { activeSubscriptions { name status } }`; persist onto `shopify_stores`.
3. Add `apps/api/src/modules/shopify/billing.routes.ts` for credit packs using `appPurchaseOneTimeCreate` with the offline token from `shopify_stores`. Set `test: true` on development stores so review can transact without real money.
4. Open the returned `confirmationUrl` **top-level**, not inside the iframe — reuse the existing `navigateTopLevel` helper in `apps/shopify/src/lib/api.ts:46-54`.
5. Grant credits on the `app_purchase_one_time/update` webhook (status `ACTIVE`), **not** on the return URL — the return URL is merchant-spoofable. Reuse the transactional grant shape in `apps/api/src/modules/merchant/payments.routes.ts`.
6. Implement the `app_subscriptions_update` handler (`webhook.routes.ts:154`) to persist status changes, covering cancel/downgrade/decline.
7. Remove `DashboardPage.tsx:278` (`Top up on tryme.com`) and rewrite `LinkAccountGate.tsx:67`. Sweep the whole SPA for any remaining outbound money links.
8. Decide the sidestep policy: a linked account can still top up on `app.tryme.com`. Reviewers check the in-app path only, but the safest posture is to route all credit purchases for Shopify-installed stores through Shopify.

### Phase 2 — REST removal (closes F4)

9. Move the four webhook topics into `[webhooks]` in `apps/shopify-extension/shopify.app.toml`, or replace the `/webhooks.json` POST with `webhookSubscriptionCreate`. Then delete `shopifyAdminFetch`'s REST path if nothing else uses it.

### Phase 3 — listing

10. Update the Partner Dashboard listing pricing from "Free" to the real plans. This is dashboard-only, no code.

### Open questions

- Razorpay stays for direct `app.tryme.com` (non-Shopify) customers — that is permitted. Confirm dual rails rather than a full migration.
- USD price points for the four tiers are needed before Managed Pricing can be configured. Shopify revenue share (15%/20%) applies to Shopify-billed revenue.
- Confirm Managed Pricing (less code, less control) over a pure Billing API subscription implementation.
