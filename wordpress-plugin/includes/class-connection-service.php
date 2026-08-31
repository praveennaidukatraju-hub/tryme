<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Verifies a full-scoped API key via GET /v1/dev/me, then discards it — only
 * the widget key and a display snapshot are ever persisted (via
 * Tryme_Connection_Settings). The full key parameter to connect() lives
 * only in this method's local scope. See docs/wordpress-plugin-design.md §4.3.
 */
class Tryme_Connection_Service
{
    public function __construct(
        private readonly Tryme_Connection_Settings $settings,
        private readonly string $apiBase
    ) {
    }

    /** @return array{ok: bool, error?: string} */
    public function connect(string $fullKey, string $widgetKey): array
    {
        $response = wp_remote_get($this->apiBase . '/v1/dev/me', [
            'headers' => ['Authorization' => 'Bearer ' . $fullKey],
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            return ['ok' => false, 'error' => 'Could not reach the tryme API.'];
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            return ['ok' => false, 'error' => 'The full API key was rejected (HTTP ' . $code . ').'];
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        $companyName = is_array($body) ? ($body['companyName'] ?? '') : '';
        $credits = is_array($body) ? (int) ($body['credits'] ?? 0) : 0;

        $this->settings->set_widget_key_and_snapshot($widgetKey, $companyName, $credits, current_time('mysql'));

        return ['ok' => true];
    }

    /**
     * Re-reads the credit balance using the already-stored widget key —
     * GET /v1/dev/balance accepts widget-scoped keys (unlike /v1/dev/me),
     * so this never requires the merchant to re-paste the full key, which
     * they're unlikely to still have (it's shown once, at creation, and
     * never again).
     *
     * @return array{ok: bool, error?: string}
     */
    public function refresh(): array
    {
        $widgetKey = $this->settings->get_widget_key();
        if ($widgetKey === null) {
            return ['ok' => false, 'error' => 'not_connected'];
        }

        $response = wp_remote_get($this->apiBase . '/v1/dev/balance', [
            'headers' => ['Authorization' => 'Bearer ' . $widgetKey],
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            return ['ok' => false, 'error' => 'Could not reach the tryme API.'];
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            return ['ok' => false, 'error' => 'The widget key was rejected (HTTP ' . $code . ').'];
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        $credits = is_array($body) ? (int) ($body['credits'] ?? 0) : 0;

        $this->settings->update_credits($credits, current_time('mysql'));

        return ['ok' => true];
    }

    /**
     * Lists the merchant's active tryme dev-API categories, for the category
     * mapping screen (§ category mapping) — GET /v1/dev/categories accepts a
     * widget-scoped key (apps/api/src/modules/dev/routes.ts), so no full key is
     * needed here.
     *
     * @return array{ok: bool, categories: array<int, array{slug: string, name: string}>, error?: string}
     */
    public function list_categories(string $widgetKey): array
    {
        $response = wp_remote_get($this->apiBase . '/v1/dev/categories', [
            'headers' => ['Authorization' => 'Bearer ' . $widgetKey],
            'timeout' => 15,
        ]);

        if (is_wp_error($response)) {
            return ['ok' => false, 'categories' => [], 'error' => 'Could not reach the tryme API.'];
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            return ['ok' => false, 'categories' => [], 'error' => 'The widget key was rejected (HTTP ' . $code . ').'];
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        $categories = is_array($body) ? ($body['categories'] ?? []) : [];

        return ['ok' => true, 'categories' => is_array($categories) ? $categories : []];
    }
}
