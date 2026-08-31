<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class PluginBootstrapTest extends TestCase
{
    public function test_plugin_file_declares_the_expected_header(): void
    {
        $contents = file_get_contents(__DIR__ . '/../../tryme-tryon.php');
        $this->assertStringContainsString('Plugin Name: Tryme Try-On', $contents);
        $this->assertStringContainsString("define('TRYME_TRYON_VERSION'", $contents);
    }

    /**
     * WordPress runtime loads classes via the explicit require_once list in
     * tryme-tryon.php, NOT Composer's classmap autoloader — that autoloader
     * only exists for these PHPUnit tests (composer.json's "autoload" key).
     * A class file present under includes/admin/public but missing from that
     * list passes every other test here (Brain\Monkey + the classmap autoload
     * it) yet fatals in a real WordPress install the instant the class is
     * used — exactly what happened with class-category-mapping.php.
     */
    public function test_every_class_file_is_required_by_the_bootstrap(): void
    {
        $pluginRoot = __DIR__ . '/../../';
        $bootstrap = file_get_contents($pluginRoot . 'tryme-tryon.php');

        $classDirs = ['includes', 'admin', 'public'];
        foreach ($classDirs as $dir) {
            foreach (glob($pluginRoot . $dir . '/*.php') as $file) {
                $relative = $dir . '/' . basename($file);
                $this->assertStringContainsString(
                    $relative,
                    $bootstrap,
                    "tryme-tryon.php is missing require_once for {$relative}"
                );
            }
        }
    }
}
