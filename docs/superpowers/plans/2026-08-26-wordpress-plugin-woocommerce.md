# WordPress/WooCommerce Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `tryme-tryon` WordPress/WooCommerce plugin per
`docs/wordpress-plugin-design.md` — merchant pastes two API keys (full key,
used once and discarded; widget key, persisted), a "Try It On" button appears
on WooCommerce product pages, and shoppers can generate and download a
try-on result, calling the API surface built in
`2026-08-26-wordpress-integration-backend.md`.

**Assumptions locked in for this plan** (the design doc left these open;
defaulting to the smaller/lazier scope rather than blocking on them — see
`docs/wordpress-plugin-design.md` §6 open questions 1–3):
- **Repo placement:** a separate repository (`tryme-tryon-woocommerce`),
  per §4.5's recommendation. This plan's paths are relative to that repo's
  root regardless of where it physically lives — nothing below depends on it
  being a monorepo folder vs. a standalone repo.
- **Distribution:** direct-download zip only. No WordPress.org readme.txt
  formatting, no SVN release tooling — that's a follow-up once the plugin is
  validated on a real store, per §4.4's recommendation.
- **Add-to-cart:** **not included.** v1 ships download-only. §6 open question
  3 left this genuinely open with no stated default; download-only is the
  smaller, immediately-shippable scope and avoids the variable-product
  variation/attribute tracking complexity §4.3 flags as a real functional
  requirement once add-to-cart is in play. Revisit as a fast-follow.

**Architecture:** Server-side PHP (WordPress Settings API + WooCommerce
product hooks) reads/writes plugin config in `wp_options` and renders a
storefront button; a browser-side widget script calls the tryme dev API
(`/v1/dev/tryon`, `/v1/dev/jobs/:id`) directly with a restricted widget key —
no PHP-side proxying of job creation or image uploads. Every class that
contains real branching logic is split so that logic is callable without a
running WordPress instance, and is unit tested that way; the thin WordPress
hook registration around it is verified by manual QA against a real
WooCommerce store, not simulated.

**Tech Stack:** PHP 8.1+, WordPress Plugin API, WooCommerce hooks, Composer,
PHPUnit 10 + Brain\Monkey (WP-function mocking without a full WP bootstrap —
the standard, minimal choice for WordPress plugin unit testing; a full
`wp-env`/WP core test suite is more infrastructure than this v1 plugin
needs). Plain vanilla JS for the storefront widget — no bundler, no frontend
framework — tested with Node's built-in test runner (`node --test`), no new
JS test dependency.

**If PHP/Composer aren't installed locally**, run every PHP command in this
plan through Docker instead — no other change needed:

```bash
docker run --rm -v "$(pwd):/app" -w /app composer:2 install
docker run --rm -v "$(pwd):/app" -w /app composer:2 dump-autoload   # after adding any new class file
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
```

(`vendor/` and generated autoload files are pure PHP — installing them via
`composer:2`'s bundled PHP and then running them under a separately pulled
`php:8.2-cli` works fine; nothing here is PHP-version-sensitive.)

---

## Task 1: Repo scaffold, Composer/PHPUnit harness, plugin bootstrap

**Files:**
- Create: `composer.json`
- Create: `phpunit.xml.dist`
- Create: `tests/php/bootstrap.php`
- Create: `tryme-tryon.php`
- Test: Create `tests/php/PluginBootstrapTest.php`

- [ ] **Step 1: Write the failing test**

```php
<?php
// tests/php/PluginBootstrapTest.php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class PluginBootstrapTest extends TestCase
{
    public function test_plugin_file_declares_the_expected_header(): void
    {
        $contents = file_get_contents(__DIR__ . '/../../tryme-tryon.php');
        $this->assertStringContainsString('Plugin Name: Tryme Try-On', $contents);
        $this->assertStringContainsString("define('TRYME_TRYON_VERSION'", $contents);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `composer install && vendor/bin/phpunit --testsuite unit`
Expected: FAIL — `tryme-tryon.php` does not exist yet.

- [ ] **Step 3: Add Composer/PHPUnit config**

Create `composer.json`:

```json
{
  "name": "tryme/tryon-woocommerce",
  "description": "Tryme Try-On for WooCommerce",
  "type": "wordpress-plugin",
  "license": "GPL-2.0-or-later",
  "require": {
    "php": ">=8.1"
  },
  "require-dev": {
    "phpunit/phpunit": "^10.5",
    "brain/monkey": "^2.6"
  },
  "autoload": {
    "classmap": ["includes/", "admin/", "public/"]
  },
  "autoload-dev": {
    "classmap": ["tests/php/"]
  }
}
```

Create `phpunit.xml.dist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="tests/php/bootstrap.php" colors="true">
  <testsuites>
    <testsuite name="unit">
      <directory>tests/php</directory>
    </testsuite>
  </testsuites>
</phpunit>
```

Create `tests/php/bootstrap.php`:

```php
<?php
declare(strict_types=1);

// Every plugin file guards against direct HTTP access with
// `if (!defined('ABSPATH')) { exit; }` — without this, that guard fires the
// instant PHPUnit autoloads any plugin class, silently killing the process
// (exit code 0, no output) with no indication of why.
if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

require_once __DIR__ . '/../../vendor/autoload.php';
```

**This matters from the very first task**, not just once WordPress-function
mocking is introduced in Task 3: the guard fires on autoload alone, before
any test body runs, so skipping this now means Task 2's tests will fail
opaquely (PHPUnit prints its header and exits 0 with zero test output — no
error, no failure message) the moment they instantiate a real plugin class.

- [ ] **Step 4: Create the plugin bootstrap file**

Create `tryme-tryon.php`:

```php
<?php
/**
 * Plugin Name: Tryme Try-On
 * Description: Adds an AI virtual try-on button to WooCommerce product pages.
 * Version: 0.1.0
 * Requires PHP: 8.1
 * Requires Plugins: woocommerce
 * License: GPL-2.0-or-later
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

define('TRYME_TRYON_VERSION', '0.1.0');
define('TRYME_TRYON_DIR', plugin_dir_path(__FILE__));
define('TRYME_TRYON_URL', plugin_dir_url(__FILE__));

require_once TRYME_TRYON_DIR . 'includes/class-connection-settings.php';
require_once TRYME_TRYON_DIR . 'includes/class-connection-service.php';
require_once TRYME_TRYON_DIR . 'includes/class-widget-config.php';
require_once TRYME_TRYON_DIR . 'admin/class-settings-page.php';
require_once TRYME_TRYON_DIR . 'public/class-widget-loader.php';

// No external calls on activation — connection happens explicitly in
// settings, per docs/wordpress-plugin-design.md §4.3.
register_activation_hook(__FILE__, function (): void {
    // Nothing to do yet: no options need a default value before first save.
});

add_action('plugins_loaded', function (): void {
    Tryme_Settings_Page::init();
    Tryme_Widget_Loader::init();
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `vendor/bin/phpunit --testsuite unit`
Expected: PASS (1 test) — the three `require_once` lines for classes that
don't exist yet will fatal-error if this test file is ever *executed* through
WordPress, but the test only reads the file as text, so it passes before
those classes exist. Task 2 onward creates them before anything tries to load
`tryme-tryon.php` for real.

- [ ] **Step 6: Commit**

```bash
git add composer.json phpunit.xml.dist tests/php/bootstrap.php tryme-tryon.php tests/php/PluginBootstrapTest.php
git commit -m "feat: scaffold plugin bootstrap and PHPUnit harness"
```

---

## Task 2: Connection settings storage (`wp_options` wrapper)

**Files:**
- Create: `includes/class-connection-settings.php`
- Test: Create `tests/php/ConnectionSettingsTest.php`

This class is the only place that reads/writes the plugin's `wp_options` row.
Per §4.3: the full API key is never persisted — only the widget key and a
`{companyName, creditsAsOf}` snapshot are stored.

- [ ] **Step 1: Write the failing test**

```php
<?php
// tests/php/ConnectionSettingsTest.php
declare(strict_types=1);

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

final class ConnectionSettingsTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Monkey\setUp();
    }

    protected function tearDown(): void
    {
        Monkey\tearDown();
        parent::tearDown();
    }

    public function test_get_widget_key_reads_from_the_options_row(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn(['widget_key' => 'sk_live_abc']);

        $settings = new Tryme_Connection_Settings();
        $this->assertSame('sk_live_abc', $settings->get_widget_key());
    }

    public function test_get_widget_key_returns_null_when_unset(): void
    {
        Functions\expect('get_option')->once()->andReturn([]);
        $settings = new Tryme_Connection_Settings();
        $this->assertNull($settings->get_widget_key());
    }

    public function test_set_widget_key_and_snapshot_persists_both_in_one_write(): void
    {
        // No get_option expectation here: set_widget_key_and_snapshot()
        // fully overwrites the option in one write — it never reads the
        // existing value first. An earlier draft of this test wrongly
        // expected a get_option call and failed with a Mockery
        // InvalidCountException ("expected exactly 1 times but called 0
        // times") — a real mismatch between the test and the implementation
        // it was written against, not a flaky test.
        Functions\expect('update_option')
            ->once()
            ->with('tryme_tryon_settings', [
                'widget_key' => 'sk_live_new',
                'company_name' => 'Acme Co',
                'credits_as_of' => '2026-08-26 00:00:00',
            ])
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->set_widget_key_and_snapshot('sk_live_new', 'Acme Co', '2026-08-26 00:00:00');

        // The assertion is the Functions\expect(...)->once()->with(...) above,
        // verified by Monkey\tearDown() — this satisfies PHPUnit's "risky
        // test" check, which otherwise flags a test with no explicit
        // assertion of its own.
        $this->addToAssertionCount(1);
    }

    public function test_never_exposes_a_setter_for_the_full_key(): void
    {
        $methods = get_class_methods(Tryme_Connection_Settings::class);
        foreach ($methods as $method) {
            $this->assertStringNotContainsStringIgnoringCase('full_key', $method);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter ConnectionSettingsTest`
Expected: FAIL — class `Tryme_Connection_Settings` does not exist.

- [ ] **Step 3: Implement the class**

Create `includes/class-connection-settings.php`:

```php
<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The ONLY class that touches the plugin's wp_options row. Deliberately has
 * no method that stores a full-scoped API key — the full key is used once
 * at connect time (see Tryme_Connection_Service) and discarded, never
 * persisted. See docs/wordpress-plugin-design.md §4.3.
 */
class Tryme_Connection_Settings
{
    private const OPTION_KEY = 'tryme_tryon_settings';

    private function all(): array
    {
        $value = get_option(self::OPTION_KEY, []);
        return is_array($value) ? $value : [];
    }

    public function get_widget_key(): ?string
    {
        return $this->all()['widget_key'] ?? null;
    }

    public function get_company_name(): ?string
    {
        return $this->all()['company_name'] ?? null;
    }

    public function get_credits_as_of(): ?string
    {
        return $this->all()['credits_as_of'] ?? null;
    }

    /**
     * The only write path for a successful connection — sets the widget key
     * and the display snapshot together, in one wp_options write.
     */
    public function set_widget_key_and_snapshot(
        string $widgetKey,
        string $companyName,
        string $creditsAsOf
    ): void {
        update_option(self::OPTION_KEY, [
            'widget_key' => $widgetKey,
            'company_name' => $companyName,
            'credits_as_of' => $creditsAsOf,
        ]);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Composer's classmap autoloader is a static generated map — it must be
regenerated whenever a new classmapped file is added, or the class "won't
exist" even though the file does.

Run: `composer dump-autoload && vendor/bin/phpunit --filter ConnectionSettingsTest`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add includes/class-connection-settings.php tests/php/ConnectionSettingsTest.php
git commit -m "feat: add connection settings storage, no full-key persistence path"
```

---

## Task 3: Full-key connection check (verify then discard)

**Files:**
- Create: `includes/class-connection-service.php`
- Test: Create `tests/php/ConnectionServiceTest.php`

- [ ] **Step 1: Write the failing test**

```php
<?php
// tests/php/ConnectionServiceTest.php
declare(strict_types=1);

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

final class ConnectionServiceTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Monkey\setUp();
    }

    protected function tearDown(): void
    {
        Monkey\tearDown();
        parent::tearDown();
    }

    public function test_successful_connect_stores_widget_key_and_snapshot_not_the_full_key(): void
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
            ->andReturn(json_encode(['companyName' => 'Acme Co', 'credits' => 500]));
        Functions\expect('current_time')->once()->with('mysql')->andReturn('2026-08-26 00:00:00');

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('set_widget_key_and_snapshot')
            ->once()
            ->with('sk_live_widget', 'Acme Co', '2026-08-26 00:00:00');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->connect('sk_live_full', 'sk_live_widget');

        $this->assertTrue($result['ok']);
    }

    public function test_network_error_does_not_touch_settings(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(new WP_Error('http_request_failed'));
        Functions\expect('is_wp_error')->once()->andReturn(true);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldNotReceive('set_widget_key_and_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->connect('sk_live_full', 'sk_live_widget');

        $this->assertFalse($result['ok']);
        $this->assertNotEmpty($result['error']);
    }

    public function test_non_200_response_does_not_touch_settings(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(['response' => ['code' => 401]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(401);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldNotReceive('set_widget_key_and_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->connect('sk_live_full', 'sk_live_widget');

        $this->assertFalse($result['ok']);
    }
}
```

This test file needs a minimal `WP_Error` stand-in, since Brain\Monkey does
not ship WordPress's real classes. Add to `tests/php/bootstrap.php` (append,
do not replace the existing `require_once` line):

```php
if (!class_exists('WP_Error')) {
    final class WP_Error
    {
        public function __construct(public string $code = '') {}
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter ConnectionServiceTest`
Expected: FAIL — class `Tryme_Connection_Service` does not exist.

- [ ] **Step 3: Implement the class**

Create `includes/class-connection-service.php`:

```php
<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Verifies a full-scoped API key via GET /v1/dev/me, then discards it — only
 * the widget key and a display snapshot are ever persisted (via
 * Tryme_Connection_Settings). The full key parameter to connect() lives
 * only in this method's local scope. See docs/wordpress-plugin-design.md §4.3.
 */
class Tryme_Connection_Service
{
    public function __construct(
        private readonly Tryme_Connection_Settings $settings,
        private readonly string $apiBase
    ) {
    }

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

        $this->settings->set_widget_key_and_snapshot($widgetKey, $companyName, current_time('mysql'));

        return ['ok' => true];
    }
}
```

Neither this class nor `Tryme_Connection_Settings` (Task 2) is declared
`final`, despite each having a docblock describing itself as "the ONLY"
class for its job — deliberately: Mockery cannot mock a `final` class
(`Mockery::mock(Tryme_Connection_Settings::class)` in the test below
throws), and the "only" claim is an architectural convention enforced by
review, not something the `final` keyword was protecting here.

- [ ] **Step 4: Run test to verify it passes**

Run: `composer dump-autoload && vendor/bin/phpunit --filter ConnectionServiceTest`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add includes/class-connection-service.php tests/php/ConnectionServiceTest.php tests/php/bootstrap.php
git commit -m "feat: add connection service that verifies and discards the full key"
```

---

## Task 4: Widget config builder (pure) + admin settings page

**Files:**
- Create: `includes/class-widget-config.php`
- Create: `admin/class-settings-page.php`
- Test: Create `tests/php/WidgetConfigTest.php`
- Test: Create `tests/php/SettingsPageSanitizeTest.php`

- [ ] **Step 1: Write the failing test for the config builder**

```php
<?php
// tests/php/WidgetConfigTest.php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class WidgetConfigTest extends TestCase
{
    public function test_builds_the_localized_config_shape(): void
    {
        $config = Tryme_Widget_Config::build(42, 'Blue Kurta', 'https://example.com/kurta.jpg');

        $this->assertSame([
            'productId' => 42,
            'productTitle' => 'Blue Kurta',
            'productImage' => 'https://example.com/kurta.jpg',
        ], $config);
    }

    public function test_falls_back_to_empty_string_for_a_missing_image(): void
    {
        $config = Tryme_Widget_Config::build(1, 'No Image Product', false);
        $this->assertSame('', $config['productImage']);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter WidgetConfigTest`
Expected: FAIL — class does not exist.

- [ ] **Step 3: Implement the pure builder**

Create `includes/class-widget-config.php`:

```php
<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Deliberately takes plain scalars, not a WC_Product — the caller
 * (Tryme_Widget_Loader) extracts id/title/image from WooCommerce, so this
 * builder has no WooCommerce dependency and needs no WordPress bootstrap to
 * test.
 */
class Tryme_Widget_Config
{
    /** @return array{productId:int,productTitle:string,productImage:string} */
    public static function build(int $productId, string $productTitle, string|false $productImage): array
    {
        return [
            'productId' => $productId,
            'productTitle' => $productTitle,
            'productImage' => $productImage !== false ? $productImage : '',
        ];
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `composer dump-autoload && vendor/bin/phpunit --filter WidgetConfigTest`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for the settings-page sanitize callback**

```php
<?php
// tests/php/SettingsPageSanitizeTest.php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class SettingsPageSanitizeTest extends TestCase
{
    public function test_trims_whitespace_around_a_pasted_key(): void
    {
        // Must match the real 43-char format the regex enforces — 'sk_live_abc'
        // is too short and would (wrongly) exercise the rejection path instead
        // of the trim path.
        $this->assertSame(
            'sk_live_' . str_repeat('a', 43),
            Tryme_Settings_Page::sanitize_key_input('  sk_live_' . str_repeat('a', 43) . '  ')
        );
    }

    public function test_rejects_a_value_not_matching_the_key_format(): void
    {
        $this->assertSame('', Tryme_Settings_Page::sanitize_key_input('not-a-key'));
    }

    public function test_accepts_empty_string_unchanged(): void
    {
        $this->assertSame('', Tryme_Settings_Page::sanitize_key_input(''));
    }
}
```

- [ ] **Step 6: Run test to verify it fails**

Run: `vendor/bin/phpunit --filter SettingsPageSanitizeTest`
Expected: FAIL — class `Tryme_Settings_Page` does not exist.

- [ ] **Step 7: Implement the settings page**

Create `admin/class-settings-page.php`:

```php
<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Native WP Settings API page under Settings → Tryme Try-On. Two paste
 * fields (full key, widget key) per docs/wordpress-plugin-design.md §4.1/§4.3.
 * The full key is used exactly once on save (Tryme_Connection_Service),
 * never rendered back into the form, never stored.
 */
class Tryme_Settings_Page
{
    private const API_BASE = 'https://api.tryme.com';

    public static function init(): void
    {
        add_action('admin_menu', [self::class, 'register_menu']);
        add_action('admin_post_tryme_tryon_connect', [self::class, 'handle_connect']);
    }

    public static function register_menu(): void
    {
        add_options_page(
            'Tryme Try-On',
            'Tryme Try-On',
            'manage_woocommerce',
            'tryme-tryon',
            [self::class, 'render']
        );
    }

    /**
     * Rejects anything not shaped like an tryme API key. A malformed
     * value is treated the same as "not provided" rather than stored and
     * failing later at connect time with a confusing error.
     */
    public static function sanitize_key_input(string $raw): string
    {
        $trimmed = trim($raw);
        if ($trimmed === '') {
            return '';
        }
        return (bool) preg_match('/^sk_live_[A-Za-z0-9_-]{43}$/', $trimmed) ? $trimmed : '';
    }

    public static function handle_connect(): void
    {
        check_admin_referer('tryme_tryon_connect');

        $fullKey = self::sanitize_key_input((string) ($_POST['tryme_full_key'] ?? ''));
        $widgetKey = self::sanitize_key_input((string) ($_POST['tryme_widget_key'] ?? ''));

        $redirectArgs = ['page' => 'tryme-tryon'];

        if ($fullKey === '' || $widgetKey === '') {
            $redirectArgs['tryme_error'] = 'invalid_key_format';
        } else {
            $service = new Tryme_Connection_Service(new Tryme_Connection_Settings(), self::API_BASE);
            $result = $service->connect($fullKey, $widgetKey);
            $redirectArgs[$result['ok'] ? 'tryme_connected' : 'tryme_error'] =
                $result['ok'] ? '1' : ($result['error'] ?? 'unknown');
        }

        wp_safe_redirect(add_query_arg($redirectArgs, admin_url('options-general.php')));
        exit;
    }

    public static function render(): void
    {
        $settings = new Tryme_Connection_Settings();
        $companyName = $settings->get_company_name();
        $creditsAsOf = $settings->get_credits_as_of();
        ?>
        <div class="wrap">
          <h1>Tryme Try-On</h1>
          <?php if ($companyName !== null): ?>
            <p>Connected as <strong><?php echo esc_html($companyName); ?></strong>
               (as of <?php echo esc_html($creditsAsOf ?? 'unknown'); ?>).</p>
          <?php else: ?>
            <p>Not connected yet.</p>
          <?php endif; ?>
          <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="tryme_tryon_connect">
            <?php wp_nonce_field('tryme_tryon_connect'); ?>
            <table class="form-table">
              <tr>
                <th><label for="tryme_full_key">Full API key</label></th>
                <td><input type="password" id="tryme_full_key" name="tryme_full_key" class="regular-text" autocomplete="off"></td>
              </tr>
              <tr>
                <th><label for="tryme_widget_key">Widget API key</label></th>
                <td><input type="password" id="tryme_widget_key" name="tryme_widget_key" class="regular-text" autocomplete="off"></td>
              </tr>
            </table>
            <?php submit_button('Test connection'); ?>
          </form>
        </div>
        <?php
    }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `composer dump-autoload && vendor/bin/phpunit --filter SettingsPageSanitizeTest`
Expected: PASS (3 tests)

- [ ] **Step 9: Manual QA (WordPress hook wiring, not unit-testable without a live install)**

Install the plugin on a local WordPress + WooCommerce test site (e.g. via
`wp-env` or a local Docker WordPress image — either is fine, this plan does
not mandate one). Verify:
1. **Settings → Tryme Try-On** appears in the admin menu.
2. Pasting a valid full key + valid widget key and clicking "Test connection"
   shows "Connected as `<company>`" after redirect.
3. Pasting a malformed key (not matching `sk_live_...`) shows an error and
   does not change the "Not connected yet." state.
4. Reloading the settings page never shows the full key back in the form —
   the field is always empty on page load (confirms it isn't round-tripped
   from storage, since it isn't stored).

- [ ] **Step 10: Commit**

```bash
git add includes/class-widget-config.php admin/class-settings-page.php tests/php/WidgetConfigTest.php tests/php/SettingsPageSanitizeTest.php
git commit -m "feat: add widget config builder and admin settings page"
```

---

## Task 5: Widget loader — hook the button into the product page

**Files:**
- Create: `public/class-widget-loader.php`
- Create: `assets/widget.css`

No new automated test in this task — `Tryme_Widget_Loader::init()` is a
thin WooCommerce-hook registration that calls the already-tested
`Tryme_Widget_Config::build()`; the hook wiring itself needs a live
WooCommerce product loop to verify meaningfully (see Step 3).

- [ ] **Step 1: Implement the loader**

Create `public/class-widget-loader.php`:

```php
<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Hooked to woocommerce_single_product_summary — reads product id/title/image
 * directly from the live $product object at render time (no sync/cache
 * problem, unlike Shopify's metafield mirror — see
 * docs/wordpress-plugin-design.md §2). Renders nothing if the merchant has
 * not connected a widget key yet.
 */
class Tryme_Widget_Loader
{
    private const API_BASE = 'https://api.tryme.com';

    public static function init(): void
    {
        add_action('woocommerce_single_product_summary', [self::class, 'render'], 25);
    }

    public static function render(): void
    {
        global $product;
        if (!$product instanceof WC_Product) {
            return;
        }

        $settings = new Tryme_Connection_Settings();
        $widgetKey = $settings->get_widget_key();
        if ($widgetKey === null) {
            return;
        }

        $imageId = $product->get_image_id();
        $imageUrl = $imageId ? wp_get_attachment_image_url($imageId, 'large') : false;
        $config = Tryme_Widget_Config::build($product->get_id(), $product->get_name(), $imageUrl);

        wp_enqueue_style('tryme-tryon-widget', TRYME_TRYON_URL . 'assets/widget.css', [], TRYME_TRYON_VERSION);
        wp_enqueue_script('tryme-tryon-widget-logic', TRYME_TRYON_URL . 'assets/widget-logic.js', [], TRYME_TRYON_VERSION, true);
        wp_enqueue_script('tryme-tryon-widget', TRYME_TRYON_URL . 'assets/widget.js', ['tryme-tryon-widget-logic'], TRYME_TRYON_VERSION, true);
        wp_localize_script('tryme-tryon-widget', 'TrymeTryOn', array_merge($config, [
            'widgetKey' => $widgetKey,
            'apiBase' => self::API_BASE,
        ]));

        echo '<button type="button" id="tryme-tryon-button" class="tryme-tryon-button">Try It On</button>';
        echo '<div id="tryme-tryon-modal" class="tryme-tryon-modal" hidden></div>';
    }
}
```

- [ ] **Step 2: Add minimal styling**

Create `assets/widget.css`:

```css
.tryme-tryon-button {
  display: inline-block;
  margin-top: 12px;
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  background: #1a1a1a;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.tryme-tryon-modal {
  position: fixed;
  inset: 0;
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
}

.tryme-tryon-modal[hidden] {
  display: none;
}

.tryme-tryon-modal-content {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  max-width: 420px;
  width: 90%;
}
```

- [ ] **Step 3: Manual QA**

On the local WordPress + WooCommerce test site from Task 4 Step 9:
1. With no widget key connected, visit any product page — confirm no
   "Try It On" button renders and no console errors appear.
2. Connect a real widget key (issued via the "Create WordPress Widget Key"
   button from `2026-08-26-wordpress-integration-backend.md` Task 8). Visit
   a simple (non-variable) product page — confirm the button renders and
   `window.TrymeTryOn` in the browser console shows the correct
   `productId`/`productTitle`/`productImage`/`widgetKey`/`apiBase`.
3. View page source — confirm the full API key never appears anywhere in
   the rendered HTML, only the widget key (expected, since it's the
   page-source-exposed credential by design).

- [ ] **Step 4: Commit**

```bash
git add public/class-widget-loader.php assets/widget.css
git commit -m "feat: render the Try It On button via the WooCommerce product hook"
```

---

## Task 6: Widget logic (pure, tested) — variation image + response classification

**Files:**
- Create: `assets/widget-logic.js`
- Test: Create `tests/js/widget-logic.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/js/widget-logic.test.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveVariationImage, classifyJobResponse } = require('../../assets/widget-logic.js');

test('resolveVariationImage: uses the variation image when the payload has one', () => {
  const result = resolveVariationImage('https://example.com/parent.jpg', {
    image: { src: 'https://example.com/variant.jpg' },
  });
  assert.equal(result, 'https://example.com/variant.jpg');
});

test('resolveVariationImage: falls back to the parent image when the variation image is empty', () => {
  const result = resolveVariationImage('https://example.com/parent.jpg', { image: { src: '' } });
  assert.equal(result, 'https://example.com/parent.jpg');
});

test('resolveVariationImage: falls back to the parent image when there is no variation payload yet', () => {
  const result = resolveVariationImage('https://example.com/parent.jpg', null);
  assert.equal(result, 'https://example.com/parent.jpg');
});

test('classifyJobResponse: 401 maps to unavailable with no retry', () => {
  const result = classifyJobResponse(401, {});
  assert.deepEqual(result, { state: 'unavailable' });
});

test('classifyJobResponse: 403 maps to unavailable', () => {
  const result = classifyJobResponse(403, {});
  assert.deepEqual(result, { state: 'unavailable' });
});

test('classifyJobResponse: 202 with status QUEUED maps to queued', () => {
  const result = classifyJobResponse(202, { jobId: 'j1', status: 'QUEUED' });
  assert.deepEqual(result, { state: 'queued' });
});

test('classifyJobResponse: 200 with status RUNNING maps to running', () => {
  const result = classifyJobResponse(200, { jobId: 'j1', status: 'RUNNING' });
  assert.deepEqual(result, { state: 'running' });
});

test('classifyJobResponse: 200 with status COMPLETED maps to completed with the image url', () => {
  const result = classifyJobResponse(200, { jobId: 'j1', status: 'COMPLETED', imageUrl: 'https://x/y.jpg' });
  assert.deepEqual(result, { state: 'completed', imageUrl: 'https://x/y.jpg' });
});

test('classifyJobResponse: 200 with status FAILED maps to failed with the error code', () => {
  const result = classifyJobResponse(200, { jobId: 'j1', status: 'FAILED', error: 'JOB_FAILED' });
  assert.deepEqual(result, { state: 'failed', error: 'JOB_FAILED' });
});

test('classifyJobResponse: any other status maps to unavailable', () => {
  const result = classifyJobResponse(500, {});
  assert.deepEqual(result, { state: 'unavailable' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "tests/js/*.test.js"`
Expected: FAIL — `../../assets/widget-logic.js` does not exist.

(Use the glob form, not a bare `node --test tests/js` directory argument —
on at least Node 24 on Windows, passing the bare directory silently tries to
resolve it as a module and reports 1 failing "test" named after the
directory itself, never actually discovering the files inside it.)

- [ ] **Step 3: Implement the pure logic module**

Create `assets/widget-logic.js`:

```javascript
// Universal module: usable as a plain <script> (attaches to window) or via
// require() in a Node test, with no build step either way.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TrymeWidgetLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * WooCommerce's variation form fires found_variation/show_variation with the
   * selected variation's data, including an `image.src`. Falls back to the
   * parent product image before any selection, for a simple product, or when
   * a variation has no image of its own. Getting this wrong sends the wrong
   * garment into the try-on job. See docs/wordpress-plugin-design.md §4.3.
   */
  function resolveVariationImage(fallbackImage, foundVariationPayload) {
    const variationSrc = foundVariationPayload && foundVariationPayload.image && foundVariationPayload.image.src;
    return variationSrc ? variationSrc : fallbackImage;
  }

  /**
   * Normalizes a /v1/dev/tryon or /v1/dev/jobs/:id response into a single UI
   * state. 401/403 map to 'unavailable' with no retry loop — a widget key can
   * be revoked out from under a live storefront at any time. See
   * docs/wordpress-plugin-design.md §4.3.
   */
  function classifyJobResponse(status, body) {
    if (status === 401 || status === 403) {
      return { state: 'unavailable' };
    }
    if ((status === 202 || status === 200) && body && body.status === 'QUEUED') {
      return { state: 'queued' };
    }
    if (status === 200 && body && body.status === 'RUNNING') {
      return { state: 'running' };
    }
    if (status === 200 && body && body.status === 'COMPLETED') {
      return { state: 'completed', imageUrl: body.imageUrl };
    }
    if (status === 200 && body && body.status === 'FAILED') {
      return { state: 'failed', error: body.error };
    }
    return { state: 'unavailable' };
  }

  return { resolveVariationImage, classifyJobResponse };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "tests/js/*.test.js"`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add assets/widget-logic.js tests/js/widget-logic.test.js
git commit -m "feat: add pure widget logic (variation image, response classification) with tests"
```

---

## Task 7: Widget browser glue — job creation, polling, download

**Files:**
- Create: `assets/widget.js`

No automated test for this file: it is DOM/fetch/WooCommerce-event wiring
around the already-tested `widget-logic.js` functions. Verified by the
manual QA checklist in Step 2, against a real product page — mocking
`fetch`, `FormData`, and WooCommerce's variation-form DOM events for an
automated test would be more test infrastructure than this glue code
justifies (it contains no branching logic of its own; all of that lives in
`widget-logic.js` and is already covered).

- [ ] **Step 1: Implement the widget**

Create `assets/widget.js`:

```javascript
(function () {
  var config = window.TrymeTryOn;
  if (!config || !config.widgetKey) return;

  var currentImage = config.productImage;
  var button = document.getElementById('tryme-tryon-button');
  var modal = document.getElementById('tryme-tryon-modal');
  if (!button || !modal) return;

  // Variable products: track the shopper's selected variation image.
  // WooCommerce's variation form fires these on jQuery, not native DOM
  // events — the theme's variation form markup guarantees jQuery is present.
  var variationForm = document.querySelector('form.variations_form');
  if (variationForm && window.jQuery) {
    window.jQuery(variationForm).on('found_variation', function (event, variation) {
      currentImage = window.TrymeWidgetLogic.resolveVariationImage(config.productImage, variation);
    });
    window.jQuery(variationForm).on('reset_data', function () {
      currentImage = config.productImage;
    });
  }

  function renderModal(html) {
    modal.innerHTML = '<div class="tryme-tryon-modal-content">' + html + '</div>';
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
    modal.innerHTML = '';
  }

  function renderUnavailable() {
    renderModal('<p>Try-on is temporarily unavailable.</p><button type="button" data-close>Close</button>');
  }

  function pollJob(jobId) {
    fetch(config.apiBase + '/v1/dev/jobs/' + jobId, {
      headers: { Authorization: 'Bearer ' + config.widgetKey },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (result) {
        var classified = window.TrymeWidgetLogic.classifyJobResponse(result.status, result.body);
        if (classified.state === 'queued' || classified.state === 'running') {
          setTimeout(function () {
            pollJob(jobId);
          }, 2000);
          return;
        }
        if (classified.state === 'completed') {
          renderModal(
            '<img src="' + classified.imageUrl + '" alt="Try-on result" style="max-width:100%">' +
              '<p><a href="' + classified.imageUrl + '" download>Download</a></p>' +
              '<button type="button" data-close>Close</button>'
          );
          return;
        }
        renderUnavailable();
      })
      .catch(renderUnavailable);
  }

  function startTryOn(personDataUrl) {
    renderModal('<p>Generating your try-on…</p>');

    fetch(currentImage)
      .then(function (r) {
        return r.blob();
      })
      .then(function (garmentBlob) {
        return fetch(personDataUrl)
          .then(function (r) {
            return r.blob();
          })
          .then(function (personBlob) {
            var form = new FormData();
            form.set('category', 'general');
            form.set('person', personBlob, 'person.jpg');
            form.set('garment', garmentBlob, 'garment.jpg');
            return fetch(config.apiBase + '/v1/dev/tryon', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + config.widgetKey },
              body: form,
            });
          });
      })
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (result) {
        if (result.status === 202 && result.body.jobId) {
          pollJob(result.body.jobId);
          return;
        }
        renderUnavailable();
      })
      .catch(renderUnavailable);
  }

  button.addEventListener('click', function () {
    renderModal(
      '<p>Upload your photo</p>' +
        '<input type="file" accept="image/*" id="tryme-tryon-file">' +
        '<p><button type="button" id="tryme-tryon-generate">Generate Try-On</button></p>' +
        '<button type="button" data-close>Close</button>'
    );
  });

  modal.addEventListener('click', function (event) {
    if (event.target.hasAttribute('data-close')) {
      closeModal();
    }
    if (event.target.id === 'tryme-tryon-generate') {
      var fileInput = document.getElementById('tryme-tryon-file');
      var file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        startTryOn(reader.result);
      };
      reader.readAsDataURL(file);
    }
  });
})();
```

- [ ] **Step 2: Manual QA**

On the local WordPress + WooCommerce test site, with a connected widget key
pointed at a real (or staging) tryme API:
1. On a simple product, click "Try It On", upload a photo, click "Generate
   Try-On" — confirm the modal shows "Generating…", then eventually either
   the result image with a working Download link, or a failure message if
   the job fails.
2. On a variable product, select a variation, open "Try It On" — confirm the
   garment fetched (`currentImage` at request time) is the variation's image,
   not the parent product's (verify via the network tab: the `garment` blob
   fetched should come from the variation's image URL).
3. Revoke the widget key from the merchant portal mid-session, then submit a
   try-on — confirm the modal shows "Try-on is temporarily unavailable." and
   does not retry automatically.
4. Confirm no request in the network tab ever carries the full API key —
   only `Authorization: Bearer <widget key>`.

- [ ] **Step 3: Commit**

```bash
git add assets/widget.js
git commit -m "feat: add storefront widget — job creation, polling, download"
```

---

## Task 8: Per-category workflow routing (§4.3a)

**Found during local end-to-end testing, not in the original plan.** The dev
API resolves its ComfyUI workflow off a `category` slug
(`createDevTryonJob` → `dev_tryon_categories`), but Task 7's `widget.js`
hardcodes `form.set('category', 'general')` for every product on every site.
That's fine for a merchant with exactly one workflow, but leaves no way for a
second workflow (e.g. a saree-specific template) to ever apply to any
product. See `docs/wordpress-plugin-design.md` §4.3a for the full writeup —
this task implements it.

**Files:**
- Create: `includes/class-category-mapping.php`
- Modify: `includes/class-connection-settings.php`
- Modify: `includes/class-connection-service.php`
- Modify: `admin/class-settings-page.php`
- Modify: `public/class-widget-loader.php`
- Modify: `assets/widget.js`
- Create: `tests/php/CategoryMappingTest.php`
- Modify: `tests/php/ConnectionServiceTest.php`
- Modify: `tests/php/ConnectionSettingsTest.php`

- [x] **Step 1: Pure resolve/sanitize functions**

`Tryme_Category_Mapping::resolve(array $productCategoryTermIds, array $map): string`
returns the first `$map[$termId]` that's set and non-empty across the
product's WooCommerce `product_cat` term IDs, else `'general'`.
`::sanitize(array $rawMap, array $validTermIds, array $validSlugs): array`
drops any entry whose term ID isn't a real WooCommerce category or whose
slug isn't a currently-active tryme category — a stale mapping (deleted
category, deactivated tryme category) must never persist. Both are pure
— no WordPress function calls — so no Brain\Monkey mocking is needed;
`tests/php/CategoryMappingTest.php` covers both directly (8 cases: mapped
hit, unmapped fallback, no categories at all, first-match-wins with
multiple categories, and 4 sanitize rejection/acceptance cases).

- [x] **Step 2: Storage — one more key in the existing `wp_options` row**

`Tryme_Connection_Settings::get_category_map(): array` /
`::set_category_map(array $map): void`, stored under `category_map` inside
the same `tryme_tryon_settings` option array Task 2 already owns — no new
option row, consistent with that class being "the ONLY class that touches
the options row."

- [x] **Step 3: Fetch the merchant's tryme categories**

`Tryme_Connection_Service::list_categories(string $widgetKey): array`
calls `GET /v1/dev/categories` with the widget key (that route accepts a
`widget`-scoped key — `apps/api/src/modules/dev/routes.ts` gates it on
`requireApiKey` only, no `requireDevScope('full')` — so no new key is
needed). Mirrors `connect()`'s `wp_remote_get`/`is_wp_error` shape exactly.

- [x] **Step 4: Settings page — the mapping screen**

Only rendered once connected (`$companyName !== null`). Lists every
WooCommerce `product_cat` term (`get_terms(['taxonomy' => 'product_cat',
'hide_empty' => false])`) with a `<select>` of the merchant's active
tryme categories (from Step 3), defaulting to "Default (general)". A new
`admin_post_tryme_tryon_save_category_map` action re-fetches both the
live WooCommerce term list and the live tryme category list at save time
and runs the posted map through `::sanitize()` before persisting — never
trusts what the form posted without re-validating against current state.

- [x] **Step 5: Widget loader resolves the product's category**

`class-widget-loader.php`'s `render()` now calls
`wp_get_post_terms($product->get_id(), 'product_cat', ['fields' => 'ids'])`,
resolves it via `Tryme_Category_Mapping::resolve()` against
`$settings->get_category_map()`, and adds `'category' => $category` to the
`wp_localize_script` payload.

- [x] **Step 6: Widget sends the resolved category**

`assets/widget.js`: `form.set('category', 'general')` →
`form.set('category', config.category || 'general')`.

- [x] **Step 7: Tests**

```bash
docker run --rm -v "$(pwd):/app" -w /app composer:2 dump-autoload
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php vendor/bin/phpunit --testsuite unit
node --test "tests/js/*.test.js"
```
Expected: PASS — 27 PHP tests (13 original + 14 new: 8 in
`CategoryMappingTest.php`, 3 new `list_categories` cases in
`ConnectionServiceTest.php`, 3 new `category_map` cases in
`ConnectionSettingsTest.php`), 10 JS tests unchanged.

- [x] **Step 8: Bump the asset version and manual QA**

`TRYME_TRYON_VERSION` → `0.3.0` (both the doc header and the `define()`)
— required for the browser to pick up the changed `widget.js`; WordPress
appends this constant as `?ver=` on every enqueued asset URL, so leaving it
unchanged serves the cached pre-change file.

Manual QA on the local dev site: Settings → Tryme Try-On → confirm the
"Try-on category mapping" section appears once connected, lists every
WooCommerce product category, map one to a real tryme category, save,
reload a product in that category, and confirm the network request to
`/v1/dev/tryon` sends the mapped `category` field (not `general`) — then
confirm an unmapped category's product still sends `general`.

- [x] **Step 9: Commit**

```bash
git add includes/class-category-mapping.php includes/class-connection-settings.php includes/class-connection-service.php admin/class-settings-page.php public/class-widget-loader.php assets/widget.js tests/php/CategoryMappingTest.php tests/php/ConnectionServiceTest.php tests/php/ConnectionSettingsTest.php tryme-tryon.php
git commit -m "feat: per-category workflow routing via WooCommerce category mapping"
```

---

## Task 9: Packaging and full regression pass

- [ ] **Step 1: Run the full PHP test suite**

Run: `vendor/bin/phpunit`
Expected: PASS, zero regressions across all `tests/php/*Test.php` files.

- [ ] **Step 2: Run the full JS test suite**

Run: `node --test "tests/js/*.test.js"`
Expected: PASS, zero regressions.

- [ ] **Step 3: Build the direct-download zip**

Per the distribution assumption at the top of this plan (direct zip, not
WordPress.org for v1), package the plugin excluding dev-only files:

```bash
rsync -a --exclude='.git' --exclude='tests' --exclude='vendor' \
  --exclude='composer.json' --exclude='composer.lock' \
  --exclude='phpunit.xml.dist' --exclude='node_modules' \
  ./ /tmp/tryme-tryon/
cd /tmp && zip -r tryme-tryon.zip tryme-tryon
```

Expected: a zip whose root contains `tryme-tryon/tryme-tryon.php`,
`includes/`, `admin/`, `public/`, `assets/` — no test or tooling files.

- [ ] **Step 4: End-to-end manual QA on a clean WordPress install**

Install the zip from Step 3 on a fresh WordPress + WooCommerce site (not the
dev site used in earlier tasks) via **Plugins → Add New → Upload Plugin**.
Repeat the full connect → button-renders → try-on → download flow from Tasks
4–7's manual QA steps. This is the first true end-to-end check that nothing
was missed by only ever testing against a dev checkout.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: v0.1.0 — direct-download zip build, full regression pass"
```
