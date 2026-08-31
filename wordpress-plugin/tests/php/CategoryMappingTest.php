<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CategoryMappingTest extends TestCase
{
    public function test_resolves_to_the_mapped_slug_for_the_product_category(): void
    {
        $slug = Tryme_Category_Mapping::resolve([12], [12 => 'saree']);
        $this->assertSame('saree', $slug);
    }

    public function test_falls_back_to_general_when_the_product_has_no_mapped_category(): void
    {
        $slug = Tryme_Category_Mapping::resolve([99], [12 => 'saree']);
        $this->assertSame('general', $slug);
    }

    public function test_falls_back_to_general_when_the_product_has_no_categories_at_all(): void
    {
        $this->assertSame('general', Tryme_Category_Mapping::resolve([], [12 => 'saree']));
    }

    public function test_uses_the_first_matching_category_when_a_product_has_several(): void
    {
        // Product is in both category 5 (unmapped) and category 12 (mapped) —
        // the first mapped one wins, order matches WooCommerce's own term order.
        $slug = Tryme_Category_Mapping::resolve([5, 12], [12 => 'saree']);
        $this->assertSame('saree', $slug);
    }

    public function test_sanitize_drops_a_term_id_not_in_the_valid_list(): void
    {
        $clean = Tryme_Category_Mapping::sanitize([12 => 'saree'], [99], ['saree']);
        $this->assertSame([], $clean);
    }

    public function test_sanitize_drops_a_slug_not_in_the_valid_list(): void
    {
        $clean = Tryme_Category_Mapping::sanitize([12 => 'not-a-real-category'], [12], ['saree']);
        $this->assertSame([], $clean);
    }

    public function test_sanitize_drops_an_empty_slug(): void
    {
        $clean = Tryme_Category_Mapping::sanitize([12 => ''], [12], ['saree']);
        $this->assertSame([], $clean);
    }

    public function test_sanitize_keeps_a_valid_mapping_and_casts_the_term_id_to_int(): void
    {
        $clean = Tryme_Category_Mapping::sanitize(['12' => 'saree'], [12], ['saree']);
        $this->assertSame([12 => 'saree'], $clean);
    }
}
