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
