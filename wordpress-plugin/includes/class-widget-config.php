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
