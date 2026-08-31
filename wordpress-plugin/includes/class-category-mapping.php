<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Maps a WooCommerce product's category (term ID) to an tryme dev-API
 * category slug, so the storefront widget can pick the right try-on workflow
 * per product instead of the single hardcoded 'general' slug. Pure functions
 * only — no wp_options access here, that's Tryme_Connection_Settings's job
 * (see its class comment: it's the ONLY class that touches the options row).
 */
class Tryme_Category_Mapping
{
    public const DEFAULT_SLUG = 'general';

    /**
     * @param int[] $productCategoryTermIds The product's WooCommerce product_cat term IDs.
     * @param array<int, string> $map term_id => tryme category slug.
     */
    public static function resolve(array $productCategoryTermIds, array $map): string
    {
        foreach ($productCategoryTermIds as $termId) {
            if (isset($map[$termId]) && $map[$termId] !== '') {
                return $map[$termId];
            }
        }
        return self::DEFAULT_SLUG;
    }

    /**
     * Drops anything that doesn't point at a real WooCommerce category or a
     * real, currently-active tryme category — a stale mapping (a deleted
     * WooCommerce category, or an tryme category since deactivated) must
     * not silently keep routing shoppers to a workflow that no longer exists,
     * nor let arbitrary POST data set an unvalidated slug.
     *
     * @param array<int|string, string> $rawMap
     * @param int[] $validTermIds
     * @param string[] $validSlugs
     * @return array<int, string>
     */
    public static function sanitize(array $rawMap, array $validTermIds, array $validSlugs): array
    {
        $clean = [];
        foreach ($rawMap as $termId => $slug) {
            $termId = (int) $termId;
            $slug = trim((string) $slug);
            if ($slug === '') {
                continue;
            }
            if (!in_array($termId, $validTermIds, true)) {
                continue;
            }
            if (!in_array($slug, $validSlugs, true)) {
                continue;
            }
            $clean[$termId] = $slug;
        }
        return $clean;
    }
}
