<?php
/**
 * One-time nav menu build for the local demo store — Home/Shop plus a real
 * Men/Women category structure with subcategory dropdowns, assigned to the
 * "primary" location Storefront renders in the header.
 *
 * Re-runnable: clears and rebuilds the menu's items each time rather than
 * appending duplicates.
 *
 * Run with: wp eval-file wp-content/plugins/tryme-tryon/local-wp/setup-navigation.php
 */

if (!defined('ABSPATH')) {
    exit;
}

function tryme_add_menu_item(int $menuId, string $title, string $url, int $parentId = 0): int
{
    $itemId = wp_update_nav_menu_item($menuId, 0, [
        'menu-item-title' => $title,
        'menu-item-url' => $url,
        'menu-item-status' => 'publish',
        'menu-item-parent-id' => $parentId,
    ]);
    if (is_wp_error($itemId)) {
        throw new RuntimeException("Failed to add menu item {$title}: " . $itemId->get_error_message());
    }
    return $itemId;
}

$menuName = 'Main Menu';
$menu = wp_get_nav_menu_object($menuName);
$menuId = $menu ? (int) $menu->term_id : wp_create_nav_menu($menuName);
if (is_wp_error($menuId)) {
    throw new RuntimeException('Failed to create menu: ' . $menuId->get_error_message());
}

foreach (wp_get_nav_menu_items($menuId) ?: [] as $item) {
    wp_delete_post($item->ID, true);
}

tryme_add_menu_item($menuId, 'Home', home_url('/'));
tryme_add_menu_item($menuId, 'Shop', (string) get_permalink(wc_get_page_id('shop')));

foreach (['men' => 'Men', 'women' => 'Women'] as $slug => $label) {
    $term = get_term_by('slug', $slug, 'product_cat');
    if (!$term instanceof WP_Term) {
        throw new RuntimeException("Category '{$slug}' not found — run import-products.php first.");
    }
    $parentItemId = tryme_add_menu_item($menuId, $label, (string) get_term_link($term));

    $children = get_terms(['taxonomy' => 'product_cat', 'parent' => $term->term_id, 'hide_empty' => false]);
    foreach ($children as $child) {
        tryme_add_menu_item($menuId, $child->name, (string) get_term_link($child), $parentItemId);
    }
}

tryme_add_menu_item($menuId, 'Cart', (string) get_permalink(wc_get_page_id('cart')));
tryme_add_menu_item($menuId, 'My Account', (string) get_permalink(wc_get_page_id('myaccount')));

$locations = get_theme_mod('nav_menu_locations', []);
$locations['primary'] = $menuId;
set_theme_mod('nav_menu_locations', $locations);

WP_CLI::success("Main Menu built (menu id {$menuId}) and assigned to the primary location.");
