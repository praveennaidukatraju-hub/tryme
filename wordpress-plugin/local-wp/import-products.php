<?php
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
    'Men' => '/home/tryme-wpdemo/import/men',
    'Women' => '/home/tryme-wpdemo/import/women',
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

function tryme_sideload_local_image(string $filePath, int $productId, string $title): int
{
    $uploadDir = wp_upload_dir();
    if (!empty($uploadDir['error'])) {
        throw new RuntimeException("Upload directory error: " . $uploadDir['error']);
    }

    $filename = wp_unique_filename($uploadDir['path'], basename($filePath));
    $destPath = $uploadDir['path'] . '/' . $filename;

    if (!copy($filePath, $destPath)) {
        throw new RuntimeException("Failed to copy {$filePath} to {$destPath}");
    }

    $filetype = wp_check_filetype($filename, null);
    $attachment = [
        'post_mime_type' => $filetype['type'] ?: 'image/jpeg',
        'post_title'     => sanitize_text_field($title),
        'post_content'   => '',
        'post_status'    => 'inherit',
    ];

    $attachmentId = wp_insert_attachment($attachment, $destPath, $productId);
    if (is_wp_error($attachmentId) || empty($attachmentId)) {
        $msg = is_wp_error($attachmentId) ? $attachmentId->get_error_message() : 'Unknown error';
        throw new RuntimeException("Failed to insert attachment for {$filePath}: " . $msg);
    }

    $attachmentData = wp_generate_attachment_metadata((int) $attachmentId, $destPath);
    wp_update_attachment_metadata((int) $attachmentId, $attachmentData);

    return (int) $attachmentId;
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

    $attachmentId = tryme_sideload_local_image($filePath, $productId, $title);
    $product->set_image_id($attachmentId);
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
