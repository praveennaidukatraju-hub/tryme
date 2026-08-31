<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * WooCommerce's own AJAX endpoint (wc-ajax=add_to_cart) takes only a bare
 * product_id + quantity — it exists solely for the simple-product "Add to
 * cart" button in loops/archives (WC_AJAX::add_to_cart()) and has no
 * variation_id/attribute handling. Variable products normally go through
 * WC_Form_Handler's non-ajax form POST + redirect instead. This handler
 * wraps WC()->cart->add_to_cart() directly so the try-on result panel can
 * add either product type without a real page navigation.
 */
class Tryme_Cart_Ajax
{
    private const ACTION = 'tryme_add_to_cart';
    public const NONCE_ACTION = 'tryme_add_to_cart';

    public static function init(): void
    {
        add_action('wp_ajax_' . self::ACTION, [self::class, 'handle']);
        add_action('wp_ajax_nopriv_' . self::ACTION, [self::class, 'handle']);
    }

    public static function handle(): void
    {
        check_ajax_referer(self::NONCE_ACTION, 'nonce');

        $productId = isset($_POST['product_id']) ? absint($_POST['product_id']) : 0;
        $variationId = isset($_POST['variation_id']) ? absint($_POST['variation_id']) : 0;

        $variationAttributes = [];
        if (isset($_POST['attributes']) && is_array($_POST['attributes'])) {
            foreach ($_POST['attributes'] as $key => $value) {
                $key = sanitize_title(wp_unslash((string) $key));
                if (str_starts_with($key, 'attribute_')) {
                    $variationAttributes[$key] = sanitize_text_field(wp_unslash((string) $value));
                }
            }
        }

        $product = $productId ? wc_get_product($productId) : false;
        if (!$product instanceof WC_Product || !$product->is_purchasable() || !$product->is_in_stock()) {
            wp_send_json_error(['message' => 'This product is currently unavailable.']);
        }

        if ($product->is_type('variable') && $variationId <= 0) {
            wp_send_json_error(['message' => 'Please select an option before adding to cart.']);
        }

        $cartItemKey = WC()->cart->add_to_cart($productId, 1, $variationId, $variationAttributes);

        if ($cartItemKey === false) {
            $errors = wc_get_notices('error');
            wc_clear_notices();
            $first = $errors[0] ?? null;
            $message = is_array($first) ? ($first['notice'] ?? null) : $first;
            wp_send_json_error(['message' => $message ? wp_strip_all_tags((string) $message) : 'Could not add to cart.']);
        }

        wp_send_json_success([
            'cartUrl' => wc_get_cart_url(),
            'count' => WC()->cart->get_cart_contents_count(),
        ]);
    }
}
