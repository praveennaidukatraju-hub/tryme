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
    // This API_BASE is sent to the BROWSER (via wp_localize_script below) —
    // widget.js runs on the shopper's machine. Production serves the API
    // from the SAME host as the web app, reverse-proxied at /v1/* (see
    // infra/docker-compose.prod.yml) — there is no separate api.tryme.com.
    // For local development, override this to 'http://localhost:4000'
    // (`pnpm --filter @tryme/api dev`, port 4000) — `localhost`, NOT
    // `host.docker.internal` (a Docker-internal DNS alias a normal browser
    // can't resolve). Contrast with Tryme_Settings_Page::API_BASE, which
    // runs server-side inside the container and does need
    // host.docker.internal.
    private const API_BASE = 'https://app.tryme.com';

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

        // Which try-on workflow runs is chosen server-side (dev_tryon_categories
        // slug -> workflow_templates), never by the plugin — this only resolves
        // WHICH slug to ask for, from the merchant's WooCommerce-category mapping
        // (Settings -> Tryme Try-On -> Category mapping). Falls back to
        // 'general' when the product's category has no mapping.
        $categoryTermIds = wp_get_post_terms($product->get_id(), 'product_cat', ['fields' => 'ids']);
        $category = Tryme_Category_Mapping::resolve(
            is_array($categoryTermIds) ? $categoryTermIds : [],
            $settings->get_category_map()
        );

        wp_enqueue_style('tryme-tryon-widget', TRYME_TRYON_URL . 'assets/widget.css', [], TRYME_TRYON_VERSION);
        wp_enqueue_script('tryme-tryon-widget-logic', TRYME_TRYON_URL . 'assets/widget-logic.js', [], TRYME_TRYON_VERSION, true);
        wp_enqueue_script('tryme-tryon-widget', TRYME_TRYON_URL . 'assets/widget.js', ['tryme-tryon-widget-logic'], TRYME_TRYON_VERSION, true);
        wp_localize_script('tryme-tryon-widget', 'TrymeTryOn', array_merge($config, [
            'widgetKey' => $widgetKey,
            'apiBase' => self::API_BASE,
            'category' => $category,
            // Add to Cart posts to WordPress's own admin-ajax.php, not the
            // Tryme API — WooCommerce cart state lives here, not on the
            // dev-API. See Tryme_Cart_Ajax.
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'addToCartNonce' => wp_create_nonce(Tryme_Cart_Ajax::NONCE_ACTION),
        ]));

        echo '<button type="button" id="tryme-tryon-button" class="tryme-tryon-button">' .
            '<svg class="tryme-button-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' .
            '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>' .
            '</svg>' .
            '<span>Try It On</span>' .
            '</button>';
        echo '<div id="tryme-tryon-modal" class="tryme-tryon-modal" hidden></div>';
    }
}
