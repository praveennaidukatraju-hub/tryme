# WordPress Plugin Admin UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the plugin's Settings → Tryme Try-On admin page up to the
same polish level as the already-redesigned storefront widget: a real
connected/not-connected distinction, a credit balance with a way to refresh
it that doesn't require re-pasting the widget key, a disconnect action, and
visible error/success feedback (currently silently dropped).

**Architecture:** No new classes, no build tooling, no JavaScript. Extends
the three existing PHP classes (`Tryme_Connection_Settings`,
`Tryme_Connection_Service`, `Tryme_Settings_Page`) and adds one plain
CSS file loaded only on this one admin screen. Collapsible sections use
native `<details>`/`<summary>`.

**Tech Stack:** PHP 8.1+, PHPUnit 10 + Brain\Monkey (existing plugin test
harness — see `wordpress-plugin/tests/php/bootstrap.php`), plain CSS.

**Full design spec:** `docs/superpowers/specs/2026-08-27-wordpress-plugin-admin-ux-design.md` — read it before starting if anything below is unclear on the "why."

**Repo location:** `wordpress-plugin/` at the repo root. All file paths below are relative to that directory unless stated otherwise.

**Test runner (this repo's established toolchain — there is no local PHP/Composer):**
```bash
cd wordpress-plugin
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
```
Run this after every task. If you ever add a NEW `.php` class file (this plan doesn't require one, but if you deviate), also run `docker run --rm -v "$(pwd):/app" -w /app composer:2 dump-autoload` first, and add a matching `require_once` line in `tryme-tryon.php` — `PluginBootstrapTest::test_every_class_file_is_required_by_the_bootstrap` will fail loudly if you forget (this exact mistake happened earlier in this project and shipped a fatal error to a live site).

---

## Task 1: `Tryme_Connection_Settings` — store and expose the credit balance

**Files:**
- Modify: `includes/class-connection-settings.php`
- Test: `tests/php/ConnectionSettingsTest.php`

The dev API's `/v1/dev/me` response already includes a `credits` field
(`packages/types/src/dev.ts`'s `DevMeResponse`), but nothing in this plugin
captures or displays it today. This task adds storage; Task 3 wires the
service layer to actually populate it.

- [ ] **Step 1: Modify the existing snapshot test to expect a `credits` field**

In `tests/php/ConnectionSettingsTest.php`, replace
`test_set_widget_key_and_snapshot_persists_both_in_one_write` (currently at
lines 40–58) with:

```php
    public function test_set_widget_key_and_snapshot_persists_both_in_one_write(): void
    {
        Functions\expect('update_option')
            ->once()
            ->with('tryme_tryon_settings', [
                'widget_key' => 'sk_live_new',
                'company_name' => 'Acme Co',
                'credits' => 500,
                'credits_as_of' => '2026-08-26 00:00:00',
            ])
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->set_widget_key_and_snapshot('sk_live_new', 'Acme Co', 500, '2026-08-26 00:00:00');

        // The assertion is the Functions\expect(...)->once()->with(...) above,
        // verified by Monkey\tearDown() — this satisfies PHPUnit's "risky test"
        // check, which otherwise flags a test with no explicit assertion.
        $this->addToAssertionCount(1);
    }
```

Then add two new tests directly after it (before
`test_never_exposes_a_setter_for_the_full_key`):

```php
    public function test_get_credits_reads_from_the_options_row(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn(['credits' => 500]);

        $settings = new Tryme_Connection_Settings();
        $this->assertSame(500, $settings->get_credits());
    }

    public function test_get_credits_returns_null_when_unset(): void
    {
        Functions\expect('get_option')->once()->andReturn([]);
        $settings = new Tryme_Connection_Settings();
        $this->assertNull($settings->get_credits());
    }
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit --filter ConnectionSettingsTest
```
Expected: FAIL — `set_widget_key_and_snapshot()` still takes 3 arguments, and `get_credits()` doesn't exist yet.

- [ ] **Step 3: Update the implementation**

In `includes/class-connection-settings.php`, replace the
`set_widget_key_and_snapshot` method (currently lines 54–68) with:

```php
    public function get_credits(): ?int
    {
        return $this->all()['credits'] ?? null;
    }

    /**
     * The only write path for a successful connection — sets the widget key
     * and the display snapshot together, in one wp_options write.
     */
    public function set_widget_key_and_snapshot(
        string $widgetKey,
        string $companyName,
        int $credits,
        string $creditsAsOf
    ): void {
        update_option(self::OPTION_KEY, [
            'widget_key' => $widgetKey,
            'company_name' => $companyName,
            'credits' => $credits,
            'credits_as_of' => $creditsAsOf,
        ]);
    }
```

(`get_credits()` placed right before it, next to the other getters, matching the file's existing top-to-bottom order: getters, then the write path.)

- [ ] **Step 4: Run the tests again, confirm they pass**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit --filter ConnectionSettingsTest
```
Expected: PASS (9 tests in this file — the existing 7 unchanged in count since the modified test replaces itself, plus the 2 new `get_credits` tests).

- [ ] **Step 5: Commit**

```bash
git add wordpress-plugin/includes/class-connection-settings.php wordpress-plugin/tests/php/ConnectionSettingsTest.php
git commit -m "feat(wordpress-plugin): store the credit balance in the connection snapshot"
```

---

## Task 2: `Tryme_Connection_Settings` — `update_snapshot()` and `clear()`

**Files:**
- Modify: `includes/class-connection-settings.php`
- Test: `tests/php/ConnectionSettingsTest.php`

`update_snapshot()` is what the (Task 4) Refresh action calls — it must
update `company_name`/`credits`/`credits_as_of` **without** touching
`widget_key` or `category_map`, since refreshing the balance must never
require re-entering the widget key. `clear()` is what Disconnect calls — it
wipes everything, including the category mapping (per the design spec's
§3b rationale: a fresh connect could be a different account with different
categories).

- [ ] **Step 1: Write the failing tests**

Add to `tests/php/ConnectionSettingsTest.php`, directly after the
`test_get_credits_returns_null_when_unset` test added in Task 1:

```php
    public function test_update_snapshot_merges_company_credits_and_timestamp_without_touching_widget_key_or_category_map(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn([
                'widget_key' => 'sk_live_widget',
                'category_map' => [12 => 'saree'],
            ]);
        Functions\expect('update_option')
            ->once()
            ->with('tryme_tryon_settings', [
                'widget_key' => 'sk_live_widget',
                'category_map' => [12 => 'saree'],
                'company_name' => 'Acme Co',
                'credits' => 750,
                'credits_as_of' => '2026-08-27 00:00:00',
            ])
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->update_snapshot('Acme Co', 750, '2026-08-27 00:00:00');

        $this->addToAssertionCount(1);
    }

    public function test_clear_deletes_the_entire_options_row(): void
    {
        Functions\expect('delete_option')
            ->once()
            ->with('tryme_tryon_settings')
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->clear();

        $this->addToAssertionCount(1);
    }
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit --filter ConnectionSettingsTest
```
Expected: FAIL — neither `update_snapshot()` nor `clear()` exist yet.

- [ ] **Step 3: Implement both methods**

In `includes/class-connection-settings.php`, add these two methods at the
end of the class, right before the closing `}`:

```php
    /**
     * Updates only the display snapshot (company/credits/timestamp) —
     * deliberately leaves widget_key and category_map untouched. Used by the
     * "Refresh balance" action, which re-verifies the full key but must never
     * require re-entering the widget key to do so.
     */
    public function update_snapshot(string $companyName, int $credits, string $creditsAsOf): void
    {
        $all = $this->all();
        $all['company_name'] = $companyName;
        $all['credits'] = $credits;
        $all['credits_as_of'] = $creditsAsOf;
        update_option(self::OPTION_KEY, $all);
    }

    /**
     * Wipes the entire stored option — widget key, snapshot, AND the category
     * mapping. A fresh connect afterward could be a different tryme
     * account with an entirely different set of categories, so a stale
     * mapping must not survive a disconnect.
     */
    public function clear(): void
    {
        delete_option(self::OPTION_KEY);
    }
```

- [ ] **Step 4: Run the tests again, confirm they pass**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit --filter ConnectionSettingsTest
```
Expected: PASS (11 tests in this file — the 9 from the end of Task 1, plus the 2 new `update_snapshot`/`clear` tests).

- [ ] **Step 5: Commit**

```bash
git add wordpress-plugin/includes/class-connection-settings.php wordpress-plugin/tests/php/ConnectionSettingsTest.php
git commit -m "feat(wordpress-plugin): add update_snapshot() and clear() to connection settings"
```

---

## Task 3: `Tryme_Connection_Service` — capture credits on connect, add `refresh()`

**Files:**
- Modify: `includes/class-connection-service.php`
- Test: `tests/php/ConnectionServiceTest.php`

- [ ] **Step 1: Modify the existing connect test and add refresh tests**

In `tests/php/ConnectionServiceTest.php`, replace the
`shouldReceive('set_widget_key_and_snapshot')` expectation inside
`test_successful_connect_stores_widget_key_and_snapshot_not_the_full_key`
(currently lines 39–41):

```php
        $settings->shouldReceive('set_widget_key_and_snapshot')
            ->once()
            ->with('sk_live_widget', 'Acme Co', 500, '2026-08-26 00:00:00');
```

(The JSON body mocked at line 35 already includes `'credits' => 500` — it
was always there, just unused until now.)

Then add three new tests directly after `test_non_200_response_does_not_touch_settings`
(before `test_list_categories_returns_the_categories_using_the_widget_key`):

```php
    public function test_successful_refresh_updates_the_snapshot_without_touching_the_widget_key(): void
    {
        Functions\expect('wp_remote_get')
            ->once()
            ->with(
                'https://api.tryme.com/v1/dev/me',
                Mockery::on(fn ($args) => $args['headers']['Authorization'] === 'Bearer sk_live_full')
            )
            ->andReturn(['response' => ['code' => 200]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(200);
        Functions\expect('wp_remote_retrieve_body')
            ->once()
            ->andReturn(json_encode(['companyName' => 'Acme Co', 'credits' => 750]));
        Functions\expect('current_time')->once()->with('mysql')->andReturn('2026-08-27 00:00:00');

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('update_snapshot')
            ->once()
            ->with('Acme Co', 750, '2026-08-27 00:00:00');
        $settings->shouldNotReceive('set_widget_key_and_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh('sk_live_full');

        $this->assertTrue($result['ok']);
    }

    public function test_refresh_network_error_does_not_touch_settings(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(new WP_Error('http_request_failed'));
        Functions\expect('is_wp_error')->once()->andReturn(true);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldNotReceive('update_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh('sk_live_full');

        $this->assertFalse($result['ok']);
        $this->assertNotEmpty($result['error']);
    }

    public function test_refresh_non_200_response_does_not_touch_settings(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(['response' => ['code' => 401]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(401);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldNotReceive('update_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh('sk_live_full');

        $this->assertFalse($result['ok']);
    }
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit --filter ConnectionServiceTest
```
Expected: FAIL — `connect()` doesn't pass credits yet, and `refresh()` doesn't exist.

- [ ] **Step 3: Update `connect()` and add `refresh()`**

In `includes/class-connection-service.php`, replace the `connect()` method
(currently lines 22–45) with:

```php
    /** @return array{ok: bool, error?: string} */
    public function connect(string $fullKey, string $widgetKey): array
    {
        $response = wp_remote_get($this->apiBase . '/v1/dev/me', [
            'headers' => ['Authorization' => 'Bearer ' . $fullKey],
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            return ['ok' => false, 'error' => 'Could not reach the tryme API.'];
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            return ['ok' => false, 'error' => 'The full API key was rejected (HTTP ' . $code . ').'];
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        $companyName = is_array($body) ? ($body['companyName'] ?? '') : '';
        $credits = is_array($body) ? (int) ($body['credits'] ?? 0) : 0;

        $this->settings->set_widget_key_and_snapshot($widgetKey, $companyName, $credits, current_time('mysql'));

        return ['ok' => true];
    }

    /**
     * Re-verifies the full key and updates only the display snapshot —
     * never the widget key. Exists as a separate method from connect() so
     * refreshing the balance never requires re-entering the widget key,
     * which a merchant is unlikely to still have (it's shown once, at
     * creation, and never again).
     *
     * @return array{ok: bool, error?: string}
     */
    public function refresh(string $fullKey): array
    {
        $response = wp_remote_get($this->apiBase . '/v1/dev/me', [
            'headers' => ['Authorization' => 'Bearer ' . $fullKey],
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            return ['ok' => false, 'error' => 'Could not reach the tryme API.'];
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            return ['ok' => false, 'error' => 'The full API key was rejected (HTTP ' . $code . ').'];
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        $companyName = is_array($body) ? ($body['companyName'] ?? '') : '';
        $credits = is_array($body) ? (int) ($body['credits'] ?? 0) : 0;

        $this->settings->update_snapshot($companyName, $credits, current_time('mysql'));

        return ['ok' => true];
    }
```

- [ ] **Step 4: Run the tests again, confirm they pass**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit --filter ConnectionServiceTest
```
Expected: PASS (9 tests in this file — the existing 6 unchanged in count since the modified test replaces itself, plus the 3 new `refresh` tests).

- [ ] **Step 5: Run the full suite to check for regressions**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
```
Expected: PASS, 35 tests total (the 28 from before this plan, +2 from Task 1, +2 from Task 2, +3 from Task 3 — the two modified tests each replace an existing one, so they add 0 net; only the newly-added tests increase the count: 28 + 2 + 2 + 3 = 35).

- [ ] **Step 6: Commit**

```bash
git add wordpress-plugin/includes/class-connection-service.php wordpress-plugin/tests/php/ConnectionServiceTest.php
git commit -m "feat(wordpress-plugin): capture credits on connect, add refresh()"
```

---

## Task 4: `Tryme_Settings_Page` — refresh and disconnect handlers

**Files:**
- Modify: `admin/class-settings-page.php`

No unit tests in this task — matching this file's existing convention:
`handle_connect()` and `handle_save_category_map()` are not unit tested
either, because they're tied to WordPress superglobals (`$_POST`) and end in
`exit`, which isn't practically unit-testable with this project's Brain\Monkey
harness. They're covered by manual QA in Task 6 instead, same as the
existing handlers always have been.

- [ ] **Step 1: Register the two new admin-post actions**

In `admin/class-settings-page.php`, replace the `init()` method (currently
lines 24–29) with:

```php
    public static function init(): void
    {
        add_action('admin_menu', [self::class, 'register_menu']);
        add_action('admin_enqueue_scripts', [self::class, 'enqueue_assets']);
        add_action('admin_post_tryme_tryon_connect', [self::class, 'handle_connect']);
        add_action('admin_post_tryme_tryon_refresh', [self::class, 'handle_refresh']);
        add_action('admin_post_tryme_tryon_disconnect', [self::class, 'handle_disconnect']);
        add_action('admin_post_tryme_tryon_save_category_map', [self::class, 'handle_save_category_map']);
    }

    /**
     * Loads the admin-only stylesheet, scoped to just this settings screen —
     * add_options_page() gives submenus of options-general.php the hook
     * suffix "settings_page_{menu_slug}" (a standard WordPress convention,
     * not specific to this plugin), so this never loads on any other admin
     * screen.
     */
    public static function enqueue_assets(string $hookSuffix): void
    {
        if ($hookSuffix !== 'settings_page_tryme-tryon') {
            return;
        }
        wp_enqueue_style(
            'tryme-tryon-settings',
            TRYME_TRYON_URL . 'admin/assets/settings-page.css',
            [],
            TRYME_TRYON_VERSION
        );
    }
```

- [ ] **Step 2: Add `handle_refresh()` and `handle_disconnect()`**

Add these two methods directly after `handle_connect()` (which ends at line
76, right before the `handle_save_category_map()` doc comment at line 78):

```php
    /**
     * Re-verifies the full key and updates the displayed company/credits
     * snapshot — deliberately does NOT touch the stored widget key, so
     * refreshing the balance never requires re-entering it.
     */
    public static function handle_refresh(): void
    {
        check_admin_referer('tryme_tryon_refresh');

        $fullKey = self::sanitize_key_input((string) ($_POST['tryme_full_key'] ?? ''));
        $redirectArgs = ['page' => 'tryme-tryon'];

        if ($fullKey === '') {
            $redirectArgs['tryme_error'] = 'invalid_key_format';
        } else {
            $settings = new Tryme_Connection_Settings();
            $service = new Tryme_Connection_Service($settings, self::API_BASE);
            $result = $service->refresh($fullKey);
            $redirectArgs[$result['ok'] ? 'tryme_refreshed' : 'tryme_error'] =
                $result['ok'] ? '1' : ($result['error'] ?? 'unknown');
        }

        wp_safe_redirect(add_query_arg($redirectArgs, admin_url('options-general.php')));
        exit;
    }

    /**
     * Wipes the entire connection — widget key, snapshot, and category
     * mapping — via Tryme_Connection_Settings::clear(). No fields, no
     * confirmation dance beyond WordPress's own nonce check; the button
     * itself is the confirmation (see the manual QA note in the plan this
     * was implemented from about not over-building a confirm-modal for a
     * reversible action — reconnecting just requires pasting keys again).
     */
    public static function handle_disconnect(): void
    {
        check_admin_referer('tryme_tryon_disconnect');

        (new Tryme_Connection_Settings())->clear();

        wp_safe_redirect(add_query_arg(
            ['page' => 'tryme-tryon', 'tryme_disconnected' => '1'],
            admin_url('options-general.php')
        ));
        exit;
    }
```

- [ ] **Step 3: Syntax-check the file**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l admin/class-settings-page.php
```
Expected: `No syntax errors detected in admin/class-settings-page.php`

- [ ] **Step 4: Run the full PHP suite to confirm no regressions**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
```
Expected: PASS, same count as the end of Task 3 (this task adds no tests).

- [ ] **Step 5: Commit**

```bash
git add wordpress-plugin/admin/class-settings-page.php
git commit -m "feat(wordpress-plugin): add refresh and disconnect admin-post actions"
```

---

## Task 5: `Tryme_Settings_Page::render()` rewrite + admin stylesheet

**Files:**
- Modify: `admin/class-settings-page.php`
- Create: `admin/assets/settings-page.css`

This is the presentational task: connected/not-connected states, visible
notices (currently silently dropped), and the card-based visual language.
No new tests — `render()` itself was never unit tested (it only emits HTML;
see the existing file's total absence of a render test), verified by manual
QA in Task 6 instead.

- [ ] **Step 1: Add the error-message map as a class constant**

In `admin/class-settings-page.php`, add this constant right after the
existing `API_BASE` constant declaration (after line 22):

```php
    // Two internal short-codes get a friendly rewrite; every other value in
    // $_GET['tryme_error'] already IS a human-readable message coming
    // straight from Tryme_Connection_Service (e.g. "The full API key was
    // rejected (HTTP 401).") and is shown as-is.
    private const ERROR_MESSAGES = [
        'invalid_key_format' => 'Please paste both keys — check they match the sk_live_… format exactly.',
        'not_connected' => 'Connect your account before mapping categories.',
    ];
```

- [ ] **Step 2: Replace `render()` and add its new helper methods**

Replace the entire `render()` method (currently lines 123–158) with:

```php
    public static function render(): void
    {
        $settings = new Tryme_Connection_Settings();
        $companyName = $settings->get_company_name();
        $credits = $settings->get_credits();
        $creditsAsOf = $settings->get_credits_as_of();
        $connected = $companyName !== null;
        ?>
        <div class="wrap tryme-settings-wrap">
          <h1>Tryme Try-On</h1>
          <?php self::render_notices(); ?>

          <?php if ($connected): ?>
            <div class="tryme-card tryme-status-card">
              <p class="tryme-status-line">
                <span class="tryme-status-dot"></span>
                Connected as <strong><?php echo esc_html($companyName); ?></strong>
              </p>
              <p class="tryme-status-sub">
                <?php echo esc_html(number_format_i18n((int) $credits)); ?> credits ·
                balance as of <?php echo esc_html($creditsAsOf ?? 'unknown'); ?>
              </p>
              <div class="tryme-status-actions">
                <details class="tryme-inline-action">
                  <summary class="button">Refresh balance</summary>
                  <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="tryme-inline-form">
                    <input type="hidden" name="action" value="tryme_tryon_refresh">
                    <?php wp_nonce_field('tryme_tryon_refresh'); ?>
                    <label for="tryme_refresh_full_key">Full API key</label>
                    <input type="password" id="tryme_refresh_full_key" name="tryme_full_key" class="regular-text" autocomplete="off">
                    <?php submit_button('Refresh', 'secondary', 'submit', false); ?>
                  </form>
                </details>

                <details class="tryme-inline-action">
                  <summary class="button">Update connection keys</summary>
                  <?php self::render_connect_form(); ?>
                </details>

                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="tryme-inline-form tryme-disconnect-form">
                  <input type="hidden" name="action" value="tryme_tryon_disconnect">
                  <?php wp_nonce_field('tryme_tryon_disconnect'); ?>
                  <button type="submit" class="button tryme-btn-danger">Disconnect</button>
                </form>
              </div>
            </div>
          <?php else: ?>
            <div class="tryme-card tryme-connect-card">
              <?php self::render_connect_form(); ?>
            </div>
          <?php endif; ?>

          <?php if ($connected): ?>
            <?php self::render_category_mapping($settings); ?>
          <?php endif; ?>
        </div>
        <?php
    }

    /** Shared by the not-connected default view and the "Update connection keys" reveal. */
    private static function render_connect_form(): void
    {
        ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="tryme-connect-form">
          <input type="hidden" name="action" value="tryme_tryon_connect">
          <?php wp_nonce_field('tryme_tryon_connect'); ?>
          <div class="tryme-connect-step">
            <div class="tryme-step-number">1</div>
            <div class="tryme-step-body">
              <label for="tryme_full_key">Full API key</label>
              <p class="description">From your tryme account → API Keys. Verified once against your account, then discarded — never stored.</p>
              <input type="password" id="tryme_full_key" name="tryme_full_key" class="regular-text" autocomplete="off">
            </div>
          </div>
          <div class="tryme-connect-step">
            <div class="tryme-step-number">2</div>
            <div class="tryme-step-body">
              <label for="tryme_widget_key">Widget API key</label>
              <p class="description">From "Create WordPress Widget Key" in the same screen. This is the key that powers the storefront button.</p>
              <input type="password" id="tryme_widget_key" name="tryme_widget_key" class="regular-text" autocomplete="off">
            </div>
          </div>
          <?php submit_button('Test connection'); ?>
        </form>
        <?php
    }

    private static function render_notices(): void
    {
        if (isset($_GET['tryme_connected'])) {
            self::render_notice('success', 'Connected successfully.');
        }
        if (isset($_GET['tryme_refreshed'])) {
            self::render_notice('success', 'Balance refreshed.');
        }
        if (isset($_GET['tryme_disconnected'])) {
            self::render_notice('success', 'Disconnected. All stored settings, including the category mapping, have been cleared.');
        }
        if (isset($_GET['tryme_category_map_saved'])) {
            self::render_notice('success', 'Category mapping saved.');
        }
        if (isset($_GET['tryme_error'])) {
            $code = (string) $_GET['tryme_error'];
            $message = self::ERROR_MESSAGES[$code] ?? $code;
            self::render_notice('error', $message);
        }
    }

    private static function render_notice(string $type, string $message): void
    {
        printf(
            '<div class="notice notice-%s is-dismissible"><p>%s</p></div>',
            esc_attr($type),
            esc_html($message)
        );
    }
```

- [ ] **Step 3: Restyle `render_category_mapping()` into a matching card**

Replace the `render_category_mapping()` method (currently lines 160–211)
with (the only changes from the current version: the wrapping `<hr>` + `<h2>`
outside a container becomes a `.tryme-card` div, and the `<h2>` moves
inside it):

```php
    /**
     * Only shown once connected — a widget key is required to list the
     * merchant's tryme categories (GET /v1/dev/categories).
     */
    private static function render_category_mapping(Tryme_Connection_Settings $settings): void
    {
        $widgetKey = $settings->get_widget_key();
        $service = new Tryme_Connection_Service($settings, self::API_BASE);
        $result = $widgetKey !== null ? $service->list_categories($widgetKey) : ['ok' => false, 'categories' => []];

        $terms = get_terms(['taxonomy' => 'product_cat', 'hide_empty' => false]);
        $productCategories = is_wp_error($terms) ? [] : $terms;
        $currentMap = $settings->get_category_map();
        ?>
        <div class="tryme-card tryme-category-card">
          <h2>Try-on category mapping</h2>
          <?php if (!$result['ok']): ?>
            <p>Could not load your tryme categories right now — try reloading this page.</p>
          <?php elseif (empty($result['categories'])): ?>
            <p>No active try-on categories are configured on your tryme account yet. Every product
               will use the <code>general</code> category until one exists.</p>
          <?php elseif (empty($productCategories)): ?>
            <p>No WooCommerce product categories found — every product uses the
               <code>general</code> try-on category.</p>
          <?php else: ?>
            <p class="description">Pick which tryme try-on workflow applies to each WooCommerce product category.
               A category left as "Default" falls back to <code>general</code>.</p>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
              <input type="hidden" name="action" value="tryme_tryon_save_category_map">
              <?php wp_nonce_field('tryme_tryon_save_category_map'); ?>
              <table class="form-table">
                <?php foreach ($productCategories as $term): ?>
                  <tr>
                    <th><label for="tryme-cat-map-<?php echo esc_attr($term->term_id); ?>"><?php echo esc_html($term->name); ?></label></th>
                    <td>
                      <select id="tryme-cat-map-<?php echo esc_attr($term->term_id); ?>" name="tryme_category_map[<?php echo esc_attr($term->term_id); ?>]">
                        <option value="">Default (general)</option>
                        <?php foreach ($result['categories'] as $cat): ?>
                          <option value="<?php echo esc_attr($cat['slug']); ?>" <?php selected($currentMap[$term->term_id] ?? '', $cat['slug']); ?>>
                            <?php echo esc_html($cat['name']); ?>
                          </option>
                        <?php endforeach; ?>
                      </select>
                    </td>
                  </tr>
                <?php endforeach; ?>
              </table>
              <?php submit_button('Save category mapping'); ?>
            </form>
          <?php endif; ?>
        </div>
        <?php
    }
```

- [ ] **Step 4: Create the admin stylesheet**

Create `admin/assets/settings-page.css` (new directory —
`admin/assets/`) with this content. Colors are WordPress's own admin design
tokens (`#2271b1` is core's link/accent blue, `#646970` core's muted text
gray, `#dcdcde` core's border gray, `#00a32a` core's success green) —
deliberately not a custom brand palette, so this never clashes with a site's
admin color-scheme setting or needs separate dark-mode handling:

```css
.tryme-settings-wrap .tryme-card {
  background: #fff;
  border: 1px solid #dcdcde;
  border-radius: 8px;
  padding: 24px;
  margin: 20px 0;
  max-width: 640px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.tryme-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  margin: 0 0 4px;
}

.tryme-status-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #00a32a;
  flex-shrink: 0;
}

.tryme-status-sub {
  margin: 0 0 18px;
  color: #646970;
  font-size: 13px;
}

.tryme-status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-start;
}

.tryme-inline-action > summary {
  list-style: none;
  cursor: pointer;
}

.tryme-inline-action > summary::-webkit-details-marker {
  display: none;
}

.tryme-inline-form {
  margin-top: 10px;
  padding: 14px;
  background: #f6f7f7;
  border: 1px solid #dcdcde;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
}

.tryme-inline-form label {
  font-weight: 600;
  font-size: 13px;
}

.tryme-btn-danger {
  color: #b32d2e;
  border-color: #b32d2e !important;
}

.tryme-btn-danger:hover {
  background: #b32d2e !important;
  color: #fff !important;
}

.tryme-connect-step {
  display: flex;
  gap: 14px;
  margin-bottom: 20px;
}

.tryme-step-number {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #2271b1;
  color: #fff;
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tryme-step-body {
  flex: 1;
}

.tryme-step-body label {
  display: block;
  font-weight: 600;
  margin-bottom: 4px;
}

.tryme-step-body .description {
  margin: 0 0 8px;
  color: #646970;
  font-size: 12.5px;
}

.tryme-category-card h2 {
  margin-top: 0;
}
```

- [ ] **Step 5: Syntax-check the PHP file**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l admin/class-settings-page.php
```
Expected: `No syntax errors detected in admin/class-settings-page.php`

- [ ] **Step 6: Run the full PHP suite to confirm no regressions**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
```
Expected: PASS, same count as the end of Task 4 (this task adds no tests, only presentation).

- [ ] **Step 7: Commit**

```bash
git add wordpress-plugin/admin/class-settings-page.php wordpress-plugin/admin/assets/settings-page.css
git commit -m "feat(wordpress-plugin): redesign the settings page — status card, notices, category mapping card"
```

---

## Task 6: Version bump, full regression, manual QA, docs

**Files:**
- Modify: `tryme-tryon.php`
- Modify: `docs/progress.md`

- [ ] **Step 1: Bump the plugin version**

In `tryme-tryon.php`, change both occurrences of the version string:

```php
 * Version: 0.4.0
```
and
```php
define('TRYME_TRYON_VERSION', '0.4.0');
```

This is required for the new `admin/assets/settings-page.css` file's
`?ver=` cache-bust to work correctly on any future edit to it, and keeps the
version number meaningful as a changelog marker.

- [ ] **Step 2: Full regression pass**

```bash
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l tryme-tryon.php
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
node --test "tests/js/*.test.js"
```
Expected: PASS on all three (PHP syntax, PHP suite 35 tests, JS suite 10 tests unchanged — this plan never touches `assets/widget.js`).

- [ ] **Step 3: Manual QA on the local dev site**

Reload `http://localhost:8888/wp-admin/options-general.php?page=tryme-tryon`
(hard-refresh to bust the browser's CSS cache) and walk through every state
transition:

1. **If currently connected**, click **Disconnect** — confirm it redirects
   back to the not-connected view (two-step numbered form), the category
   mapping section is gone, and a dismissible success notice reading
   "Disconnected. All stored settings, including the category mapping, have
   been cleared." appears.
2. **Connect**: paste a valid full key and widget key, submit. Confirm the
   status card appears with a real credit number and a dismissible "Connected
   successfully." notice. Confirm the storefront "Try It On" button still
   renders on a product page.
3. **Refresh balance**: click it to reveal the inline field, paste the full
   key again, submit. Confirm the credit number/timestamp update and a
   "Balance refreshed." notice appears — and confirm the storefront button
   still works immediately after (proving the widget key was untouched).
4. **Update connection keys**: click it to reveal the two-step form, submit
   with the same or a different widget key. Confirm it updates the
   connection the same way the initial connect did.
5. **Category mapping**: confirm the mapping table now renders inside a
   card matching the status card's visual style, and that saving a mapping
   still shows a "Category mapping saved." notice (previously silent).
6. **Error paths**: submit the connect form with an empty full key — confirm
   a visible error notice reading "Please paste both keys — check they match
   the sk_live_… format exactly." Submit Refresh with a garbage full key —
   confirm a visible error notice with the HTTP rejection message.

- [ ] **Step 4: Update `docs/progress.md`**

Add a dated entry (today's date) under "Done" summarizing: settings page
redesigned with a connected/not-connected split, a credit balance now
captured and displayed, a refresh action that re-verifies the full key
without touching the stored widget key, a disconnect action that clears
the entire connection including the category mapping, and previously-silent
success/error flash messages now rendered as WP admin notices. Reference
`docs/superpowers/specs/2026-08-27-wordpress-plugin-admin-ux-design.md` for
the full design rationale.

- [ ] **Step 5: Commit**

```bash
git add wordpress-plugin/tryme-tryon.php docs/progress.md
git commit -m "chore(wordpress-plugin): v0.4.0 — admin UX redesign regression pass"
```
