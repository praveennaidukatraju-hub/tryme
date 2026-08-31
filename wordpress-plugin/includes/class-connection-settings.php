<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The ONLY class that touches the plugin's wp_options row. Deliberately has
 * no method that stores a full-scoped API key — the full key is used once
 * at connect time (see Tryme_Connection_Service) and discarded, never
 * persisted. See docs/wordpress-plugin-design.md §4.3.
 */
class Tryme_Connection_Settings
{
    private const OPTION_KEY = 'tryme_tryon_settings';

    private function all(): array
    {
        $value = get_option(self::OPTION_KEY, []);
        return is_array($value) ? $value : [];
    }

    public function get_widget_key(): ?string
    {
        return $this->all()['widget_key'] ?? null;
    }

    public function get_company_name(): ?string
    {
        return $this->all()['company_name'] ?? null;
    }

    public function get_credits_as_of(): ?string
    {
        return $this->all()['credits_as_of'] ?? null;
    }

    /** @return array<int, string> WooCommerce product_cat term_id => tryme category slug. */
    public function get_category_map(): array
    {
        $map = $this->all()['category_map'] ?? [];
        return is_array($map) ? $map : [];
    }

    /** @param array<int, string> $map */
    public function set_category_map(array $map): void
    {
        $all = $this->all();
        $all['category_map'] = $map;
        update_option(self::OPTION_KEY, $all);
    }

    public function get_credits(): ?int
    {
        return $this->all()['credits'] ?? null;
    }

    /**
     * The only write path for a successful connection — sets the widget key
     * and the display snapshot together, in one wp_options write.
     */
    public function set_widget_key_and_snapshot(
        string $widgetKey,
        string $companyName,
        int $credits,
        string $creditsAsOf
    ): void {
        update_option(self::OPTION_KEY, [
            'widget_key' => $widgetKey,
            'company_name' => $companyName,
            'credits' => $credits,
            'credits_as_of' => $creditsAsOf,
        ]);
    }

    /**
     * Updates only the credit balance and its timestamp — deliberately
     * leaves widget_key, company_name, and category_map untouched. Used by
     * the "Refresh balance" action, which reads GET /v1/dev/balance with the
     * already-stored widget key and so never needs to re-verify identity.
     */
    public function update_credits(int $credits, string $creditsAsOf): void
    {
        $all = $this->all();
        $all['credits'] = $credits;
        $all['credits_as_of'] = $creditsAsOf;
        update_option(self::OPTION_KEY, $all);
    }

    /**
     * Wipes the entire stored option — widget key, snapshot, AND the category
     * mapping. A fresh connect afterward could be a different tryme
     * account with an entirely different set of categories, so a stale
     * mapping must not survive a disconnect.
     */
    public function clear(): void
    {
        delete_option(self::OPTION_KEY);
    }
}
