<?php
declare(strict_types=1);

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

final class ConnectionSettingsTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Monkey\setUp();
    }

    protected function tearDown(): void
    {
        Monkey\tearDown();
        parent::tearDown();
    }

    public function test_get_widget_key_reads_from_the_options_row(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn(['widget_key' => 'sk_live_abc']);

        $settings = new Tryme_Connection_Settings();
        $this->assertSame('sk_live_abc', $settings->get_widget_key());
    }

    public function test_get_widget_key_returns_null_when_unset(): void
    {
        Functions\expect('get_option')->once()->andReturn([]);
        $settings = new Tryme_Connection_Settings();
        $this->assertNull($settings->get_widget_key());
    }

    public function test_set_widget_key_and_snapshot_persists_both_in_one_write(): void
    {
        Functions\expect('update_option')
            ->once()
            ->with('tryme_tryon_settings', [
                'widget_key' => 'sk_live_new',
                'company_name' => 'Acme Co',
                'credits' => 500,
                'credits_as_of' => '2026-08-26 00:00:00',
            ])
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->set_widget_key_and_snapshot('sk_live_new', 'Acme Co', 500, '2026-08-26 00:00:00');

        // The assertion is the Functions\expect(...)->once()->with(...) above,
        // verified by Monkey\tearDown() — this satisfies PHPUnit's "risky test"
        // check, which otherwise flags a test with no explicit assertion.
        $this->addToAssertionCount(1);
    }

    public function test_get_credits_reads_from_the_options_row(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn(['credits' => 500]);

        $settings = new Tryme_Connection_Settings();
        $this->assertSame(500, $settings->get_credits());
    }

    public function test_get_credits_returns_null_when_unset(): void
    {
        Functions\expect('get_option')->once()->andReturn([]);
        $settings = new Tryme_Connection_Settings();
        $this->assertNull($settings->get_credits());
    }

    public function test_update_credits_merges_balance_and_timestamp_without_touching_widget_key_company_name_or_category_map(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn([
                'widget_key' => 'sk_live_widget',
                'company_name' => 'Acme Co',
                'category_map' => [12 => 'saree'],
            ]);
        Functions\expect('update_option')
            ->once()
            ->with('tryme_tryon_settings', [
                'widget_key' => 'sk_live_widget',
                'company_name' => 'Acme Co',
                'category_map' => [12 => 'saree'],
                'credits' => 750,
                'credits_as_of' => '2026-08-27 00:00:00',
            ])
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->update_credits(750, '2026-08-27 00:00:00');

        $this->addToAssertionCount(1);
    }

    public function test_clear_deletes_the_entire_options_row(): void
    {
        Functions\expect('delete_option')
            ->once()
            ->with('tryme_tryon_settings')
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->clear();

        $this->addToAssertionCount(1);
    }

    public function test_get_category_map_reads_from_the_options_row(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn(['category_map' => [12 => 'saree']]);

        $settings = new Tryme_Connection_Settings();
        $this->assertSame([12 => 'saree'], $settings->get_category_map());
    }

    public function test_get_category_map_returns_empty_array_when_unset(): void
    {
        Functions\expect('get_option')->once()->andReturn([]);
        $settings = new Tryme_Connection_Settings();
        $this->assertSame([], $settings->get_category_map());
    }

    public function test_set_category_map_merges_into_the_existing_options_row(): void
    {
        Functions\expect('get_option')
            ->once()
            ->with('tryme_tryon_settings', [])
            ->andReturn(['widget_key' => 'sk_live_widget']);
        Functions\expect('update_option')
            ->once()
            ->with('tryme_tryon_settings', [
                'widget_key' => 'sk_live_widget',
                'category_map' => [12 => 'saree'],
            ])
            ->andReturn(true);

        $settings = new Tryme_Connection_Settings();
        $settings->set_category_map([12 => 'saree']);

        $this->addToAssertionCount(1);
    }

    public function test_never_exposes_a_setter_for_the_full_key(): void
    {
        $methods = get_class_methods(Tryme_Connection_Settings::class);
        foreach ($methods as $method) {
            $this->assertStringNotContainsStringIgnoringCase('full_key', $method);
        }
    }
}
