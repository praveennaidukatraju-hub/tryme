<?php
/**
 * One-time WooCommerce/WordPress settings for the local demo store: INR
 * currency, Cash-on-Delivery-only checkout, guest checkout, no tax, a
 * flat-rate shipping zone, pretty permalinks, and disabling WooCommerce's
 * "Coming Soon" mode. Every change here is an option update — naturally
 * idempotent, safe to re-run.
 *
 * The last two are fresh-install defaults that silently block the entire
 * storefront if left as-is: Plain permalinks mean /shop/ and friends 404
 * through to the blog homepage instead of resolving, and Coming Soon mode
 * shows every visitor a placeholder page regardless of how the catalog or
 * theme are configured underneath. Both were found the hard way — the
 * theme/catalog/checkout work landed and was reported "verified" before
 * either was fixed, so nothing after that point could actually have been
 * loaded in a browser.
 *
 * Run with: wp eval-file wp-content/plugins/tryme-tryon/local-wp/configure-store.php
 */

if (!defined('ABSPATH')) {
    exit;
}

update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules();

update_option('woocommerce_coming_soon', 'no');

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

// Registration was off (WooCommerce default), which makes WooCommerce's own
// my-account template skip its two-column login/register layout entirely
// and render a bare, unstyled login form with no way for a new visitor to
// create an account — not what a real storefront's account page looks like.
update_option('woocommerce_enable_myaccount_registration', 'yes');
update_option('woocommerce_registration_generate_username', 'yes');
update_option('woocommerce_registration_generate_password', 'yes');

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
