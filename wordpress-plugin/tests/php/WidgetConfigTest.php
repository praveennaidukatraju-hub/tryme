<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class WidgetConfigTest extends TestCase
{
    public function test_builds_the_localized_config_shape(): void
    {
        $config = Tryme_Widget_Config::build(42, 'Blue Kurta', 'https://example.com/kurta.jpg');

        $this->assertSame([
            'productId' => 42,
            'productTitle' => 'Blue Kurta',
            'productImage' => 'https://example.com/kurta.jpg',
        ], $config);
    }

    public function test_falls_back_to_empty_string_for_a_missing_image(): void
    {
        $config = Tryme_Widget_Config::build(1, 'No Image Product', false);
        $this->assertSame('', $config['productImage']);
    }
}
