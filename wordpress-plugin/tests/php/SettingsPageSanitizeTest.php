<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class SettingsPageSanitizeTest extends TestCase
{
    public function test_trims_whitespace_around_a_pasted_key(): void
    {
        $this->assertSame('sk_live_' . str_repeat('a', 43), Tryme_Settings_Page::sanitize_key_input('  sk_live_' . str_repeat('a', 43) . '  '));
    }

    public function test_rejects_a_value_not_matching_the_key_format(): void
    {
        $this->assertSame('', Tryme_Settings_Page::sanitize_key_input('not-a-key'));
    }

    public function test_accepts_empty_string_unchanged(): void
    {
        $this->assertSame('', Tryme_Settings_Page::sanitize_key_input(''));
    }
}
