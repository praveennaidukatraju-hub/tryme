# WordPress Plugin Admin UX — Design

> **Status:** Approved design, not yet implemented.
> **Scope:** The plugin's admin-facing surface — Settings → Tryme Try-On
> (`admin/class-settings-page.php` and its supporting classes). The
> storefront widget (button + modal) already received a full "SaaS-grade"
> redesign outside this spec (`assets/widget.css`, `assets/widget.js`) and is
> explicitly out of scope here.

---

## 1. Goal

Bring the plugin's admin screen up to the same "polished but native" bar as
the already-redesigned storefront widget: real visual hierarchy, a proper
connected/not-connected distinction, visible error/success feedback, and two
new capabilities (refresh balance, disconnect) that don't exist today —
without leaving native WordPress admin conventions (WP's own spacing,
typography, button classes, color-scheme support) or introducing any new
build tooling. Still plain PHP + one small CSS file; no JS framework, no
bundler.

## 2. Current state (what's being replaced)

`admin/class-settings-page.php`'s `render()` today:
- Always shows the same flat two-password-field form, connected or not.
- Shows connection status as one plain `<p>` line, or "Not connected yet."
- Sets `tryme_connected` / `tryme_error` / `tryme_category_map_saved`
  query-string flags on every redirect from `handle_connect()` and
  `handle_save_category_map()` — **but `render()` never reads or displays
  any of them.** Every success and every error is currently silent from the
  merchant's point of view; they only find out something happened by
  eyeballing whether the "Connected as X" line changed.
- Has no way to disconnect, and no way to refresh the displayed credit
  balance short of re-running the full two-key connect flow.
- The category-mapping table (added in the previous session) is a bare WP
  `form-table`, visually disconnected from the page around it.

## 3. States & actions

The page renders one of two top-level states.

### 3a. Not connected

A two-step connect form:

```
① Full API key
   From your tryme account → API Keys. Verified once against your
   account, then discarded — never stored.
   [___________________________]

② Widget API key
   From "Create WordPress Widget Key" in the same screen. This is the key
   that powers the storefront button — store it here once.
   [___________________________]

   [Test connection]
```

Submits to the existing `tryme_tryon_connect` action — no change to
`handle_connect()`'s logic, only to what's rendered around it.

### 3b. Connected

A status card:

```
● Connected as Ai Vastra Dev
  1,240 credits · balance as of 2026-08-27 05:43

  [Refresh balance ▾]  [Update connection keys ▾]  [Disconnect]
```

- **Refresh balance** (`<details>`, no JS): reveals a single full-key field.
  Submits to a *new* `tryme_tryon_refresh` action that re-verifies via
  `/v1/dev/me` and updates only `company_name`/`credits`/`credits_as_of` —
  the stored `widget_key` is untouched. This exists as its own action
  specifically so refreshing the balance never requires re-pasting the
  widget key, which a merchant likely no longer has on hand (it's shown
  once, at creation, and never again).
- **Update connection keys** (`<details>`, no JS): reveals the same two-step
  form as the not-connected state, still posting to `tryme_tryon_connect`.
  This is the path for actually rotating the widget key or switching which
  tryme account is connected.
- **Disconnect**: a new `tryme_tryon_disconnect` action (its own nonce,
  no fields) that wipes the entire stored option — widget key, snapshot,
  *and* the category mapping. Category mapping is cleared too because a
  fresh connect could point at a different tryme account with an
  entirely different set of categories; keeping stale term→slug entries
  around risks silently routing to slugs that belong to nobody, or worse,
  to the wrong account's workflow.

Below the status card, the category-mapping section (unchanged behavior,
restyled into a matching card — see §5).

## 4. Data & service layer changes

**`includes/class-connection-settings.php`** (still the only class that
touches `wp_options`):
- `set_widget_key_and_snapshot(string $widgetKey, string $companyName, int $credits, string $creditsAsOf): void`
  — adds `$credits` as a new positional parameter to the existing atomic
  snapshot write. (Breaking signature change from the current 3-arg form —
  there are no other callers besides `Tryme_Connection_Service::connect()`,
  updated in the same change.)
- `get_credits(): ?int` — new getter, same shape as `get_company_name()`.
- `update_snapshot(string $companyName, int $credits, string $creditsAsOf): void`
  — new. Rewrites only `company_name`/`credits`/`credits_as_of` inside the
  existing options array; leaves `widget_key` and `category_map` exactly as
  they were. This is what the Refresh action calls.
- `clear(): void` — new. `delete_option(self::OPTION_KEY)`. This is what
  Disconnect calls.

**`includes/class-connection-service.php`**:
- `connect()`: now also reads `credits` from the `/v1/dev/me` response body
  (`$body['credits'] ?? 0` — the field already exists in `DevMeResponse`,
  just discarded today) and passes it through to
  `set_widget_key_and_snapshot()`.
- `refresh(string $fullKey): array{ok: bool, error?: string}` — new method,
  identical shape to `connect()`. Same `wp_remote_get('/v1/dev/me', ...)`
  call; on success, calls `$this->settings->update_snapshot(...)` instead of
  `set_widget_key_and_snapshot(...)`. The service keeps owning "when do we
  persist," matching how `connect()` already works — the settings page never
  writes to `Tryme_Connection_Settings` directly.

**`admin/class-settings-page.php`**:
- `handle_connect()` — unchanged.
- `handle_refresh()` — new. `check_admin_referer('tryme_tryon_refresh')`,
  reads one field (`tryme_full_key`), calls `$service->refresh()`,
  redirects with `tryme_refreshed=1` or `tryme_error=...`.
- `handle_disconnect()` — new. `check_admin_referer('tryme_tryon_disconnect')`,
  no fields, calls `$settings->clear()`, redirects with
  `tryme_disconnected=1`.
- `render()` — branches on `$settings->get_company_name() !== null` for
  §3a/§3b, and now reads `$_GET['tryme_connected']` /
  `tryme_refreshed` / `tryme_disconnected` / `tryme_category_map_saved`
  / `tryme_error` to render one dismissible WP admin notice
  (`.notice.notice-success` / `.notice-error`) per request. Two internal
  short error-codes get a friendly rewrite (`invalid_key_format` →
  "Please paste both keys — check they match the sk_live_… format exactly.",
  `not_connected` → "Connect your account before mapping categories.");
  every other error string already comes as human-readable text from the
  service layer (e.g. "The full API key was rejected (HTTP 401).") and is
  shown as-is via `esc_html()`.
- `enqueue_assets(string $hookSuffix)` — new, hooked to
  `admin_enqueue_scripts`. Enqueues `admin/assets/settings-page.css` only
  when `$hookSuffix === 'settings_page_tryme-tryon'` (the hook suffix WP
  assigns to a page registered via `add_options_page` with menu slug
  `tryme-tryon`), so the stylesheet never loads on unrelated admin
  screens.

No changes to `includes/class-category-mapping.php` or
`includes/class-widget-config.php` — this spec doesn't touch resolution
logic, only presentation and the two new account-level actions.

## 5. Visual & copy details

- **New file**: `admin/assets/settings-page.css`. Provides: `.tryme-status-card`
  (background, border-radius, padding, a colored status dot), the two-step
  numbered connect form layout, and a card wrapper reused for the
  category-mapping section so both sections read as one consistent design
  language. Action buttons (`Refresh balance`, `Update connection keys`,
  `Disconnect`, `Save category mapping`, `Test connection`) all use WP's own
  `.button` / `.button-primary` / `.button-secondary` classes so they
  inherit whatever admin color scheme the site (or the individual logged-in
  user) has configured — only card chrome and spacing are custom.
- **Collapsible sections** (`Refresh balance`, `Update connection keys`) use
  plain `<details>`/`<summary>` — zero JavaScript, keeps this a fully
  server-rendered PHP page.
- **Notices** render directly under the `<h1>`, using
  `<div class="notice notice-success is-dismissible"><p>...</p></div>` (WP's
  own dismiss behavior — `wp-admin` already loads the JS that wires up
  `is-dismissible`, no additional script needed).
- **Version bump**: `TRYME_TRYON_VERSION` → `0.4.0` (the version this
  spec's implementation ships as), for the new stylesheet's `?ver=` cache
  bust — consistent with why it was bumped for the two previous plugin
  changes this session.

## 6. Out of scope

- The storefront widget (button + modal) — already redesigned separately.
- Any change to `/v1/dev/*` API behavior, credit accounting, or the
  dev-API-categories mechanism itself.
- A "forgot my widget key" recovery flow beyond what Refresh/Update already
  provide — if a merchant has lost both the full key and the widget key,
  they generate new ones from the merchant portal, same as today.
- Multi-site / multi-account support — one connection per WordPress install,
  unchanged.

## 7. Testing

- `tests/php/ConnectionSettingsTest.php`: update the existing
  `set_widget_key_and_snapshot` test for the new `$credits` parameter; add
  cases for `get_credits()` (set / unset), `update_snapshot()` (merges
  without touching `widget_key`/`category_map`), and `clear()` (calls
  `delete_option`).
- `tests/php/ConnectionServiceTest.php`: update the existing `connect()`
  success case to assert `credits` is passed through; add `refresh()` cases
  mirroring `connect()`'s three (`success`, `network error`, `non-200
  response`) — success asserts `update_snapshot` was called and
  `set_widget_key_and_snapshot` was NOT.
- No new class files are introduced, so `PluginBootstrapTest`'s
  require-completeness guard needs no changes.
- `php -l` on every touched file (existing Docker toolchain:
  `docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l <file>`).
- Manual QA on the local dev site, covering every state transition in §3:
  not-connected → connect → status card appears with a real credit number;
  Refresh balance updates the timestamp without clearing/changing the
  stored widget key (verify the storefront button still works immediately
  after); Update connection keys successfully rotates the widget key;
  Disconnect reverts to the not-connected view and the category-mapping
  section is gone (re-connecting shows an empty mapping, not the old one);
  a malformed key on connect and a rejected key on refresh both show a
  visible dismissible error notice.
