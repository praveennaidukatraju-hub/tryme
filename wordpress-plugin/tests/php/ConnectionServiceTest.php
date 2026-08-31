<?php
declare(strict_types=1);

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

final class ConnectionServiceTest extends TestCase
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

    public function test_successful_connect_stores_widget_key_and_snapshot_not_the_full_key(): void
    {
        Functions\expect('wp_remote_get')
            ->once()
            ->with(
                'https://api.tryme.com/v1/dev/me',
                Mockery::on(fn ($args) => $args['headers']['Authorization'] === 'Bearer sk_live_full')
            )
            ->andReturn(['response' => ['code' => 200]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(200);
        Functions\expect('wp_remote_retrieve_body')
            ->once()
            ->andReturn(json_encode(['companyName' => 'Acme Co', 'credits' => 500]));
        Functions\expect('current_time')->once()->with('mysql')->andReturn('2026-08-26 00:00:00');

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('set_widget_key_and_snapshot')
            ->once()
            ->with('sk_live_widget', 'Acme Co', 500, '2026-08-26 00:00:00');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->connect('sk_live_full', 'sk_live_widget');

        $this->assertTrue($result['ok']);
    }

    public function test_network_error_does_not_touch_settings(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(new WP_Error('http_request_failed'));
        Functions\expect('is_wp_error')->once()->andReturn(true);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldNotReceive('set_widget_key_and_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->connect('sk_live_full', 'sk_live_widget');

        $this->assertFalse($result['ok']);
        $this->assertNotEmpty($result['error']);
    }

    public function test_non_200_response_does_not_touch_settings(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(['response' => ['code' => 401]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(401);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldNotReceive('set_widget_key_and_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->connect('sk_live_full', 'sk_live_widget');

        $this->assertFalse($result['ok']);
    }

    public function test_successful_refresh_updates_credits_using_the_stored_widget_key(): void
    {
        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('get_widget_key')->once()->andReturn('sk_live_widget');

        Functions\expect('wp_remote_get')
            ->once()
            ->with(
                'https://api.tryme.com/v1/dev/balance',
                Mockery::on(fn ($args) => $args['headers']['Authorization'] === 'Bearer sk_live_widget')
            )
            ->andReturn(['response' => ['code' => 200]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(200);
        Functions\expect('wp_remote_retrieve_body')
            ->once()
            ->andReturn(json_encode(['credits' => 750]));
        Functions\expect('current_time')->once()->with('mysql')->andReturn('2026-08-27 00:00:00');

        $settings->shouldReceive('update_credits')
            ->once()
            ->with(750, '2026-08-27 00:00:00');
        $settings->shouldNotReceive('set_widget_key_and_snapshot');

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh();

        $this->assertTrue($result['ok']);
    }

    public function test_refresh_without_a_stored_widget_key_does_not_call_the_api(): void
    {
        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('get_widget_key')->once()->andReturn(null);
        $settings->shouldNotReceive('update_credits');

        Functions\expect('wp_remote_get')->never();

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh();

        $this->assertFalse($result['ok']);
    }

    public function test_refresh_network_error_does_not_touch_settings(): void
    {
        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('get_widget_key')->once()->andReturn('sk_live_widget');
        $settings->shouldNotReceive('update_credits');

        Functions\expect('wp_remote_get')->once()->andReturn(new WP_Error('http_request_failed'));
        Functions\expect('is_wp_error')->once()->andReturn(true);

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh();

        $this->assertFalse($result['ok']);
        $this->assertNotEmpty($result['error']);
    }

    public function test_refresh_non_200_response_does_not_touch_settings(): void
    {
        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $settings->shouldReceive('get_widget_key')->once()->andReturn('sk_live_widget');
        $settings->shouldNotReceive('update_credits');

        Functions\expect('wp_remote_get')->once()->andReturn(['response' => ['code' => 401]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(401);

        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->refresh();

        $this->assertFalse($result['ok']);
    }

    public function test_list_categories_returns_the_categories_using_the_widget_key(): void
    {
        Functions\expect('wp_remote_get')
            ->once()
            ->with(
                'https://api.tryme.com/v1/dev/categories',
                Mockery::on(fn ($args) => $args['headers']['Authorization'] === 'Bearer sk_live_widget')
            )
            ->andReturn(['response' => ['code' => 200]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(200);
        Functions\expect('wp_remote_retrieve_body')
            ->once()
            ->andReturn(json_encode(['categories' => [['slug' => 'general', 'name' => 'General']]]));

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->list_categories('sk_live_widget');

        $this->assertTrue($result['ok']);
        $this->assertSame([['slug' => 'general', 'name' => 'General']], $result['categories']);
    }

    public function test_list_categories_returns_not_ok_on_network_error(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(new WP_Error('http_request_failed'));
        Functions\expect('is_wp_error')->once()->andReturn(true);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->list_categories('sk_live_widget');

        $this->assertFalse($result['ok']);
        $this->assertSame([], $result['categories']);
    }

    public function test_list_categories_returns_not_ok_when_the_widget_key_is_rejected(): void
    {
        Functions\expect('wp_remote_get')->once()->andReturn(['response' => ['code' => 401]]);
        Functions\expect('is_wp_error')->once()->andReturn(false);
        Functions\expect('wp_remote_retrieve_response_code')->once()->andReturn(401);

        $settings = Mockery::mock(Tryme_Connection_Settings::class);
        $service = new Tryme_Connection_Service($settings, 'https://api.tryme.com');
        $result = $service->list_categories('sk_live_widget');

        $this->assertFalse($result['ok']);
        $this->assertSame([], $result['categories']);
    }
}
