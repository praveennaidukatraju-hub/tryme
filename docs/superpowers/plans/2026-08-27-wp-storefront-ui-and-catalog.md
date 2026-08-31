# WooCommerce Demo Storefront — Theme, Catalog & Checkout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **A note on "tests" in this plan:** most of this work is WP-CLI commands and
> content/configuration, not application code — there is nothing to unit-test,
> the same way `class-settings-page.php`'s `render()` has no automated tests.
> Every task's "verify" step runs a real command against the real local
> WordPress site and checks real output. That IS the test for this plan.

**Goal:** Turn the local WooCommerce test site (`wordpress-plugin/local-wp/`)
from the default theme + one dummy product into a realistic demo store: a
Storefront child theme in Tryme's brand colors, all 432 real garment
images imported as categorized, priced products, and a working
Cash-on-Delivery checkout.

**Architecture:** No new application code. A version-controlled Storefront
child theme (CSS + a two-line `functions.php`), two one-time PHP scripts run
via `wp eval-file` inside the existing `wpcli` container (`import-products.php`
for the catalog, `configure-store.php` for payment/shipping/tax settings),
and two new `docker-compose.yml` volume mounts (the child theme directory,
and the two source image folders read-only).

**Tech Stack:** WordPress, WooCommerce, WP-CLI, Docker Compose (existing
`wordpress-plugin/local-wp/` stack — services `db`, `wordpress`, `wpcli`,
containers named `local-wp-db-1`, `local-wp-wordpress-1`, `local-wp-wpcli-1`).

**Full design spec:** `docs/superpowers/specs/2026-08-27-wp-storefront-ui-and-catalog-design.md`

**Repo location:** All relative paths below are relative to `wordpress-plugin/`
unless stated otherwise. Run `docker exec` commands from anywhere (they target
containers by name); run `docker compose` commands from `wordpress-plugin/local-wp/`.

**A note on Windows/git-bash:** container-side paths passed to `docker exec`
must be prefixed with `MSYS_NO_PATHCONV=1` in this shell, or git-bash mangles
paths like `/var/www/html` into a Windows path before Docker ever sees them
(established earlier this session — every `wp` command below needs it).

---

## Task 1: Mount the child theme directory and source image folders

**Files:**
- Modify: `local-wp/docker-compose.yml`

The two source folders (`men garments/`, `womens garments/`) live at the repo
root, two levels up from `local-wp/` — nothing in either container can see
them today. The child theme (Task 2) needs to be visible to both `wordpress`
(to serve it) and `wpcli` (to run `wp theme activate` against it), mirroring
how the plugin and WooCommerce are already mounted into both services.

- [ ] **Step 1: Edit `local-wp/docker-compose.yml`**

Add one line to the `wordpress` service's `volumes:` list (after the existing
WooCommerce line):
```yaml
      - ./themes/storefront-tryme:/var/www/html/wp-content/themes/storefront-tryme
```

Add the same theme line, plus the two read-only source mounts, to the
`wpcli` service's `volumes:` list:
```yaml
      - ./themes/storefront-tryme:/var/www/html/wp-content/themes/storefront-tryme
      - "../../men garments:/import/men:ro"
      - "../../womens garments:/import/women:ro"
```
(Quote the last two — the host paths contain spaces.)

The full `wpcli` service block should now read:
```yaml
  wpcli:
    image: wordpress:cli-php8.1
    depends_on:
      - db
      - wordpress
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
    volumes:
      - wp_data:/var/www/html
      - ../:/var/www/html/wp-content/plugins/tryme-tryon
      - ./plugins/woocommerce:/var/www/html/wp-content/plugins/woocommerce
      - ./themes/storefront-tryme:/var/www/html/wp-content/themes/storefront-tryme
      - "../../men garments:/import/men:ro"
      - "../../womens garments:/import/women:ro"
    entrypoint: ["tail", "-f", "/dev/null"]
```

- [ ] **Step 2: Create the (empty for now) theme directory so Docker has something to mount**

```bash
mkdir -p "D:/tryme/webtool/wordpress-plugin/local-wp/themes/storefront-tryme"
```

- [ ] **Step 3: Recreate the containers with the new mounts**

```bash
cd D:/tryme/webtool/wordpress-plugin/local-wp
docker compose up -d
```
Expected: `local-wp-wordpress-1` and `local-wp-wpcli-1` show `Recreated` (not
`Running` unchanged) in the output — confirms the volume config actually
changed.

- [ ] **Step 4: Verify the source folders are visible inside `wpcli`**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 ls /import/men
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 ls /import/women
```
Expected: 9 subfolder names for `/import/men` (`blazers`, `full sleeve
shirts`, …), 4 for `/import/women` (`womens hoodies`, …).

- [ ] **Step 5: Commit**

```bash
git add wordpress-plugin/local-wp/docker-compose.yml
git commit -m "chore(wordpress-plugin): mount child theme dir and garment asset folders into local-wp"
```

---

## Task 2: Storefront child theme

**Files:**
- Create: `local-wp/themes/storefront-tryme/style.css`
- Create: `local-wp/themes/storefront-tryme/functions.php`

- [ ] **Step 1: Install the Storefront parent theme**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp theme install storefront --allow-root --path=/var/www/html
```
Expected: `Success: Theme installed successfully.` (or `Theme already
installed.` if this is a re-run — either is fine).

- [ ] **Step 2: Create `local-wp/themes/storefront-tryme/style.css`**

```css
/*
Theme Name: Storefront Tryme
Template: storefront
Description: Storefront child theme skinned with Tryme's brand palette for the demo storefront.
Version: 1.0.0
*/

:root {
  --tryme-primary: #0f172a;
  --tryme-primary-hover: #1e293b;
  --tryme-accent: #6366f1;
  --tryme-surface: #ffffff;
  --tryme-surface-subtle: #f8fafc;
  --tryme-border: #e2e8f0;
  --tryme-text-main: #0f172a;
  --tryme-text-muted: #64748b;
}

.main-navigation ul li a:hover,
.main-navigation ul li a:focus {
  color: var(--tryme-accent);
}

/* Buttons: add to cart, place order, proceed to checkout, apply coupon, etc. */
.woocommerce a.button,
.woocommerce button.button,
.woocommerce input.button,
.woocommerce #respond input#submit,
a.button.alt,
button.button.alt,
input.button.alt {
  background-color: var(--tryme-primary) !important;
  border-color: var(--tryme-primary) !important;
  color: #fff !important;
  border-radius: 8px;
}

.woocommerce a.button:hover,
.woocommerce button.button:hover,
.woocommerce input.button:hover,
a.button.alt:hover,
button.button.alt:hover,
input.button.alt:hover {
  background-color: var(--tryme-primary-hover) !important;
  border-color: var(--tryme-primary-hover) !important;
}

/* Product grid cards (shop page, category archives) */
ul.products li.product {
  background: var(--tryme-surface);
  border: 1px solid var(--tryme-border);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition:
    box-shadow 0.15s ease,
    transform 0.15s ease;
}

ul.products li.product:hover {
  box-shadow: 0 8px 24px -8px rgba(15, 23, 42, 0.16);
  transform: translateY(-2px);
}

ul.products li.product .price {
  color: var(--tryme-primary);
  font-weight: 700;
}

/* Single product page */
.single-product div.product p.price,
.single-product div.product span.price {
  color: var(--tryme-primary);
  font-weight: 700;
}

/* Cart & checkout */
.woocommerce table.shop_table {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--tryme-border);
}

.woocommerce-checkout #payment {
  background: var(--tryme-surface-subtle);
  border-radius: 12px;
}
```

- [ ] **Step 3: Create `local-wp/themes/storefront-tryme/functions.php`**

```php
<?php
declare(strict_types=1);

add_action('wp_enqueue_scripts', function (): void {
    wp_enqueue_style('storefront-style', get_template_directory_uri() . '/style.css');
    wp_enqueue_style(
        'storefront-tryme-style',
        get_stylesheet_directory_uri() . '/style.css',
        ['storefront-style'],
        wp_get_theme()->get('Version')
    );
});
```

- [ ] **Step 4: Syntax-check the PHP file**

```bash
cd D:/tryme/webtool/wordpress-plugin
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l local-wp/themes/storefront-tryme/functions.php
```
Expected: `No syntax errors detected`.

- [ ] **Step 5: Activate the child theme and verify**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp theme activate storefront-tryme --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp theme list --allow-root --path=/var/www/html
```
Expected: the second command's `status` column shows `active` next to
`storefront-tryme`.

- [ ] **Step 6: Commit**

```bash
git add wordpress-plugin/local-wp/themes/storefront-tryme/
git commit -m "feat(wordpress-plugin): add Storefront child theme in Tryme brand colors"
```

---

## Task 3: Catalog import script

**Files:**
- Create: `local-wp/import-products.php`

This script is not part of the distributable plugin (it lives under
`local-wp/`, same as `docker-compose.yml`) — a one-time local data seed, run
manually, never `require`'d by `tryme-tryon.php`.

- [ ] **Step 1: Create `local-wp/import-products.php`**

```php
<?php
declare(strict_types=1);

/**
 * One-time catalog seed for the local demo store — creates the Men/Women
 * category tree and one WooCommerce product per image under /import/men and
 * /import/women (see docker-compose.yml's wpcli volume mounts).
 *
 * Idempotent: re-running skips any image already imported, tracked via the
 * _tryme_import_source postmeta (format "{category-slug}::{filename}").
 *
 * Run with: wp eval-file wp-content/plugins/tryme-tryon/local-wp/import-products.php
 */

if (!defined('ABSPATH')) {
    exit;
}

require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

const TRYME_CATEGORY_MAP = [
    'blazers' => ['slug' => 'blazers', 'name' => 'Blazer', 'parent' => 'Men'],
    'full sleeve shirts' => ['slug' => 'full-sleeve-shirts', 'name' => 'Full Sleeve Shirt', 'parent' => 'Men'],
    'full sleeve tshirts' => ['slug' => 'full-sleeve-tshirts', 'name' => 'Full Sleeve T-Shirt', 'parent' => 'Men'],
    'half sleeve shirts' => ['slug' => 'half-sleeve-shirts', 'name' => 'Half Sleeve Shirt', 'parent' => 'Men'],
    'half sleeve Tshirts' => ['slug' => 'half-sleeve-tshirts', 'name' => 'Half Sleeve T-Shirt', 'parent' => 'Men'],
    'hoodies' => ['slug' => 'hoodies', 'name' => 'Hoodie', 'parent' => 'Men'],
    'jackets' => ['slug' => 'jackets', 'name' => 'Jacket', 'parent' => 'Men'],
    'polo' => ['slug' => 'polo', 'name' => 'Polo', 'parent' => 'Men'],
    'sleeveless tshirts' => ['slug' => 'sleeveless-tshirts', 'name' => 'Sleeveless T-Shirt', 'parent' => 'Men'],
    'womens hoodies' => ['slug' => 'womens-hoodies', 'name' => 'Hoodie', 'parent' => 'Women'],
    'womens jackets' => ['slug' => 'womens-jackets', 'name' => 'Jacket', 'parent' => 'Women'],
    'womens shirts' => ['slug' => 'womens-shirts', 'name' => 'Shirt', 'parent' => 'Women'],
    'womens sweatshirts' => ['slug' => 'womens-sweatshirts', 'name' => 'Sweatshirt', 'parent' => 'Women'],
];

const TRYME_PRICE_RANGES = [
    'blazers' => [3999, 6999],
    'full-sleeve-shirts' => [899, 1799],
    'full-sleeve-tshirts' => [699, 1299],
    'half-sleeve-shirts' => [799, 1599],
    'half-sleeve-tshirts' => [599, 1099],
    'hoodies' => [1299, 2499],
    'jackets' => [2499, 4999],
    'polo' => [799, 1499],
    'sleeveless-tshirts' => [499, 899],
    'womens-hoodies' => [1299, 2499],
    'womens-jackets' => [2499, 4999],
    'womens-shirts' => [899, 1799],
    'womens-sweatshirts' => [1199, 2199],
];

const TRYME_SOURCE_ROOTS = [
    'Men' => '/import/men',
    'Women' => '/import/women',
];

function tryme_get_or_create_term(string $name, string $slug, int $parentId): int
{
    $existing = get_term_by('slug', $slug, 'product_cat');
    if ($existing instanceof WP_Term) {
        return $existing->term_id;
    }
    $result = wp_insert_term($name, 'product_cat', ['slug' => $slug, 'parent' => $parentId]);
    if (is_wp_error($result)) {
        throw new RuntimeException("Failed to create category {$slug}: " . $result->get_error_message());
    }
    return (int) $result['term_id'];
}

function tryme_already_imported(string $sourceTag): bool
{
    $existing = get_posts([
        'post_type' => 'product',
        'post_status' => 'any',
        'meta_key' => '_tryme_import_source',
        'meta_value' => $sourceTag,
        'posts_per_page' => 1,
        'fields' => 'ids',
    ]);
    return !empty($existing);
}

function tryme_import_one(
    string $filePath,
    string $categorySlug,
    int $categoryTermId,
    string $displayName,
    string $genderLabel,
    int $counter,
    array $priceRange
): bool {
    $sourceTag = $categorySlug . '::' . basename($filePath);
    if (tryme_already_imported($sourceTag)) {
        return false;
    }

    $price = wp_rand($priceRange[0], $priceRange[1]);
    $title = "{$genderLabel}'s {$displayName} #{$counter}";

    $product = new WC_Product_Simple();
    $product->set_name($title);
    $product->set_status('publish');
    $product->set_catalog_visibility('visible');
    $product->set_regular_price((string) $price);
    $product->set_stock_status('instock');
    $product->set_category_ids([$categoryTermId]);
    $productId = $product->save();

    update_post_meta($productId, '_tryme_import_source', $sourceTag);

    $attachmentId = media_sideload_image($filePath, $productId, $title, 'id');
    if (is_wp_error($attachmentId)) {
        throw new RuntimeException("Failed to sideload image for {$sourceTag}: " . $attachmentId->get_error_message());
    }
    $product->set_image_id((int) $attachmentId);
    $product->save();

    return true;
}

$parentIds = [
    'Men' => tryme_get_or_create_term('Men', 'men', 0),
    'Women' => tryme_get_or_create_term('Women', 'women', 0),
];

$imported = 0;
$skipped = 0;
foreach (TRYME_CATEGORY_MAP as $folder => $meta) {
    $termId = tryme_get_or_create_term($meta['name'], $meta['slug'], $parentIds[$meta['parent']]);
    $dir = TRYME_SOURCE_ROOTS[$meta['parent']] . '/' . $folder;
    if (!is_dir($dir)) {
        WP_CLI::warning("Missing source directory: {$dir}");
        continue;
    }

    $files = array_values(array_diff(scandir($dir), ['.', '..']));
    sort($files);
    $priceRange = TRYME_PRICE_RANGES[$meta['slug']];

    $counter = 0;
    foreach ($files as $file) {
        $counter++;
        $created = tryme_import_one(
            $dir . '/' . $file,
            $meta['slug'],
            $termId,
            $meta['name'],
            $meta['parent'],
            $counter,
            $priceRange
        );
        $created ? $imported++ : $skipped++;
    }
}

WP_CLI::success("Imported {$imported} new products, skipped {$skipped} already-imported images.");
```

- [ ] **Step 2: Syntax-check the file**

```bash
cd D:/tryme/webtool/wordpress-plugin
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l local-wp/import-products.php
```
Expected: `No syntax errors detected`.

- [ ] **Step 3: Run the import**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp eval-file wp-content/plugins/tryme-tryon/local-wp/import-products.php --allow-root --path=/var/www/html
```
Expected: `Success: Imported 432 new products, skipped 0 already-imported images.`
(This uploads 432 images — expect this to take a few minutes.)

- [ ] **Step 4: Verify the product count and category tree**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp post list --post_type=product --format=count --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp term list product_cat --fields=name,slug,parent,count --allow-root --path=/var/www/html
```
Expected: post count is `433` (432 imported + the pre-existing "Orange
Hoodie"). The term list shows `Men` and `Women` with `parent=0`, and 13 child
terms (9 under `Men`'s term id, 4 under `Women`'s) with non-zero `count`
values summing to 432.

- [ ] **Step 5: Verify idempotency — re-run and confirm nothing duplicates**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp eval-file wp-content/plugins/tryme-tryon/local-wp/import-products.php --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp post list --post_type=product --format=count --allow-root --path=/var/www/html
```
Expected: `Success: Imported 0 new products, skipped 432 already-imported
images.`, and the post count is still `433`.

- [ ] **Step 6: Commit**

```bash
git add wordpress-plugin/local-wp/import-products.php
git commit -m "feat(wordpress-plugin): add idempotent catalog import script for the demo store"
```

---

## Task 4: Store configuration script

**Files:**
- Create: `local-wp/configure-store.php`

- [ ] **Step 1: Create `local-wp/configure-store.php`**

```php
<?php
declare(strict_types=1);

/**
 * One-time WooCommerce settings for the local demo store: INR currency,
 * Cash-on-Delivery-only checkout, guest checkout, no tax, and a flat-rate
 * shipping zone. Every change here is an option update — naturally
 * idempotent, safe to re-run.
 *
 * Run with: wp eval-file wp-content/plugins/tryme-tryon/local-wp/configure-store.php
 */

if (!defined('ABSPATH')) {
    exit;
}

update_option('woocommerce_currency', 'INR');

update_option('woocommerce_cod_settings', array_merge(
    (array) get_option('woocommerce_cod_settings', []),
    ['enabled' => 'yes', 'title' => 'Cash on Delivery']
));

foreach (['bacs', 'cheque', 'paypal'] as $gateway) {
    update_option("woocommerce_{$gateway}_settings", array_merge(
        (array) get_option("woocommerce_{$gateway}_settings", []),
        ['enabled' => 'no']
    ));
}

update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_calc_taxes', 'no');

$zoneExists = false;
foreach (WC_Shipping_Zones::get_zones() as $zone) {
    if ($zone['zone_name'] === 'Everywhere') {
        $zoneExists = true;
        break;
    }
}

if (!$zoneExists) {
    $zone = new WC_Shipping_Zone();
    $zone->set_zone_name('Everywhere');
    $zone->save();

    $instanceId = $zone->add_shipping_method('flat_rate');
    $settings = get_option("woocommerce_flat_rate_{$instanceId}_settings", []);
    $settings['cost'] = '99';
    $settings['title'] = 'Standard Shipping';
    update_option("woocommerce_flat_rate_{$instanceId}_settings", $settings);
}

WP_CLI::success('Store configuration applied.');
```

- [ ] **Step 2: Syntax-check the file**

```bash
cd D:/tryme/webtool/wordpress-plugin
docker run --rm -v "$(pwd):/app" -w /app php:8.2-cli php -l local-wp/configure-store.php
```
Expected: `No syntax errors detected`.

- [ ] **Step 3: Run it**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp eval-file wp-content/plugins/tryme-tryon/local-wp/configure-store.php --allow-root --path=/var/www/html
```
Expected: `Success: Store configuration applied.`

- [ ] **Step 4: Verify settings**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_currency --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_calc_taxes --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_enable_guest_checkout --allow-root --path=/var/www/html
```
Expected: `INR`, `no`, `yes`.

- [ ] **Step 5: Verify the WooCommerce core pages are set** (auto-created on
install — this confirms it, doesn't create anything)

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_cart_page_id --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_checkout_page_id --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_myaccount_page_id --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp option get woocommerce_shop_page_id --allow-root --path=/var/www/html
```
Expected: each prints a non-zero post ID. If any prints `0` or empty, create
the missing page in wp-admin (Pages → Add New, insert the matching WooCommerce
block/shortcode) and set it under WooCommerce → Settings → Advanced before
continuing — but this is not expected on an existing WooCommerce install.

- [ ] **Step 6: Verify idempotency — re-run and confirm no duplicate shipping zone**

```bash
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp eval-file wp-content/plugins/tryme-tryon/local-wp/configure-store.php --allow-root --path=/var/www/html
MSYS_NO_PATHCONV=1 docker exec local-wp-wpcli-1 wp eval 'echo count(WC_Shipping_Zones::get_zones());' --allow-root --path=/var/www/html
```
Expected: `Success: Store configuration applied.` again, and the zone count
printed is `1`.

- [ ] **Step 7: Commit**

```bash
git add wordpress-plugin/local-wp/configure-store.php
git commit -m "feat(wordpress-plugin): configure demo store currency, COD checkout, and flat-rate shipping"
```

---

## Task 5: Manual checkout walkthrough, regression check, docs

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Confirm the Tryme plugin's category-mapping table now shows the real catalog**

Visit `http://localhost:8888/wp-admin/options-general.php?page=tryme-tryon`
(reconnect first if disconnected). Under "Try-on category mapping", confirm
the WooCommerce category list now shows real names (Blazer, Hoodie, Jacket,
etc.) instead of just "Uncategorized"/"Men".

- [ ] **Step 2: Full guest checkout walkthrough on the storefront**

1. Visit `http://localhost:8888/shop/` (or `/?post_type=product`) — confirm
   the brand-colored product grid renders with real garment photos, not the
   default Storefront demo look.
2. Open any product, click **Add to cart**.
3. Go to the cart page, confirm the ₹99 "Standard Shipping" line appears,
   click **Proceed to checkout**.
4. Fill in a dummy guest address (no account required — confirm no login
   prompt blocks this), confirm **Cash on Delivery** is the only payment
   option shown, and place the order.
5. Confirm the order confirmation page renders with a real order number.

- [ ] **Step 3: Confirm the storefront try-on button still works**

On the same product page from Step 2, confirm the "Try It On" button and
modal still render correctly (proves the new theme's CSS doesn't collide
with `assets/widget.css`'s modal styles).

- [ ] **Step 4: Update `docs/progress.md`**

Add a dated entry (today's date) under "Done" summarizing: Storefront child
theme in Tryme brand colors, 432 real garment products imported across 13
categories (Men: 9, Women: 4) via an idempotent import script, and a
Cash-on-Delivery-only checkout with flat-rate shipping and guest checkout
enabled. Reference
`docs/superpowers/specs/2026-08-27-wp-storefront-ui-and-catalog-design.md`
for the full design, and note that VPS deployment is a deliberately separate,
not-yet-started follow-up.

- [ ] **Step 5: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record the WooCommerce demo storefront theme/catalog/checkout work"
```
