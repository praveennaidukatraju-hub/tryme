<?php
/**
 * One-time homepage build for the local demo store — a hero banner, Men/Women
 * category tiles, and a "New Arrivals" product grid, set as the site's static
 * front page. Also trashes WordPress's default seed content (the "Hello
 * world!" post, the "Sample Page") so the site doesn't read as a fresh
 * install with a store bolted on.
 *
 * Re-runnable: updates the existing "Home" page in place rather than
 * creating duplicates.
 *
 * Run with: wp eval-file wp-content/plugins/tryme-tryon/local-wp/setup-homepage.php
 */

if (!defined('ABSPATH')) {
    exit;
}

function tryme_first_product_image(string $categorySlug): string
{
    $posts = get_posts([
        'post_type' => 'product',
        'numberposts' => 1,
        'tax_query' => [['taxonomy' => 'product_cat', 'field' => 'slug', 'terms' => $categorySlug]],
    ]);
    if (empty($posts)) {
        throw new RuntimeException("No products found in category '{$categorySlug}' — run import-products.php first.");
    }
    $url = wp_get_attachment_image_url(get_post_thumbnail_id($posts[0]->ID), 'large');
    if (!$url) {
        throw new RuntimeException("Product in '{$categorySlug}' has no featured image.");
    }
    return $url;
}

$menImage = tryme_first_product_image('blazers');
$womenImage = tryme_first_product_image('womens-hoodies');
$shopUrl = (string) get_permalink(wc_get_page_id('shop'));

$menTerm = get_term_by('slug', 'men', 'product_cat');
$womenTerm = get_term_by('slug', 'women', 'product_cat');
if (!$menTerm instanceof WP_Term || !$womenTerm instanceof WP_Term) {
    throw new RuntimeException("Men/Women categories not found — run import-products.php first.");
}
$menUrl = (string) get_term_link($menTerm);
$womenUrl = (string) get_term_link($womenTerm);

$content = <<<HTML
<!-- wp:group {"style":{"spacing":{"padding":{"top":"80px","bottom":"80px"}},"color":{"background":"#0f172a"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-background" style="background-color:#0f172a;padding-top:80px;padding-bottom:80px">
<!-- wp:heading {"textAlign":"center","level":1,"style":{"color":{"text":"#ffffff"}}} -->
<h1 class="wp-block-heading has-text-align-center" style="color:#ffffff">Fashion That Fits — Before You Buy</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"color":{"text":"#cbd5e1"}}} -->
<p class="has-text-align-center" style="color:#cbd5e1">Try on any garment virtually with Tryme's AI-powered try-on, right from the product page.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"style":{"color":{"background":"#6366f1"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-background wp-element-button" style="background-color:#6366f1" href="{$shopUrl}">Shop Now</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->
</div>
<!-- /wp:group -->

<!-- wp:columns -->
<div class="wp-block-columns">
<!-- wp:column -->
<div class="wp-block-column">
<!-- wp:cover {"url":"{$menImage}","dimRatio":40,"minHeight":360} -->
<div class="wp-block-cover" style="min-height:360px"><span aria-hidden="true" class="wp-block-cover__background has-background-dim-40 has-background-dim"></span><img class="wp-block-cover__image-background" alt="" src="{$menImage}" data-object-fit="cover"/><div class="wp-block-cover__inner-container">
<!-- wp:heading {"textAlign":"center","style":{"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#ffffff">Men</h2>
<!-- /wp:heading -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"className":"is-style-outline","style":{"color":{"text":"#ffffff"}}} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" style="color:#ffffff;border-color:#ffffff" href="{$menUrl}">Shop Men</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->
</div></div>
<!-- /wp:cover -->
</div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">
<!-- wp:cover {"url":"{$womenImage}","dimRatio":40,"minHeight":360} -->
<div class="wp-block-cover" style="min-height:360px"><span aria-hidden="true" class="wp-block-cover__background has-background-dim-40 has-background-dim"></span><img class="wp-block-cover__image-background" alt="" src="{$womenImage}" data-object-fit="cover"/><div class="wp-block-cover__inner-container">
<!-- wp:heading {"textAlign":"center","style":{"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#ffffff">Women</h2>
<!-- /wp:heading -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"className":"is-style-outline","style":{"color":{"text":"#ffffff"}}} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" style="color:#ffffff;border-color:#ffffff" href="{$womenUrl}">Shop Women</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->
</div></div>
<!-- /wp:cover -->
</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->

<!-- wp:heading {"textAlign":"center","style":{"spacing":{"margin":{"top":"48px"}}}} -->
<h2 class="wp-block-heading has-text-align-center" style="margin-top:48px">New Arrivals</h2>
<!-- /wp:heading -->

<!-- wp:shortcode -->
[products limit="8" columns="4" orderby="date" order="DESC"]
<!-- /wp:shortcode -->
HTML;

$existing = get_page_by_path('home');
$postData = [
    'post_title' => 'Home',
    'post_name' => 'home',
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_content' => $content,
];
if ($existing instanceof WP_Post) {
    $postData['ID'] = $existing->ID;
}
$homeId = wp_insert_post($postData);
if (is_wp_error($homeId) || $homeId === 0) {
    throw new RuntimeException('Failed to create/update the Home page.');
}

update_option('show_on_front', 'page');
update_option('page_on_front', $homeId);

// Clean up WordPress's default seed content so the site doesn't read as a
// fresh install with a store bolted onto it.
$helloWorldPosts = get_posts(['name' => 'hello-world', 'post_type' => 'post', 'post_status' => 'publish', 'numberposts' => 1]);
if (!empty($helloWorldPosts)) {
    wp_trash_post($helloWorldPosts[0]->ID);
}
$samplePage = get_page_by_path('sample-page');
if ($samplePage instanceof WP_Post && $samplePage->post_status !== 'trash') {
    wp_trash_post($samplePage->ID);
}

WP_CLI::success("Homepage set to page id {$homeId}, default seed content trashed.");
