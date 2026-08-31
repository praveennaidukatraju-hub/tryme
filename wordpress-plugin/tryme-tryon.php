<?php
/**
 * Plugin Name: Tryme Try-On
 * Description: Adds an AI virtual try-on button to WooCommerce product pages.
 * Version: 0.4.5
 * Requires PHP: 8.1
 * Requires Plugins: woocommerce
 * License: GPL-2.0-or-later
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

define('TRYME_TRYON_VERSION', '0.4.5');
define('TRYME_TRYON_DIR', plugin_dir_path(__FILE__));
define('TRYME_TRYON_URL', plugin_dir_url(__FILE__));

require_once TRYME_TRYON_DIR . 'includes/class-connection-settings.php';
require_once TRYME_TRYON_DIR . 'includes/class-connection-service.php';
require_once TRYME_TRYON_DIR . 'includes/class-widget-config.php';
require_once TRYME_TRYON_DIR . 'includes/class-category-mapping.php';
require_once TRYME_TRYON_DIR . 'includes/class-cart-ajax.php';
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
    Tryme_Cart_Ajax::init();
});
