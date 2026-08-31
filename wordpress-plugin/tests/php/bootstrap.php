<?php
declare(strict_types=1);

// Every plugin file guards against direct HTTP access with
// `if (!defined('ABSPATH')) { exit; }` — without this, that guard fires the
// instant PHPUnit autoloads any plugin class, silently killing the process
// (exit code 0, no output) with no indication of why.
if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

require_once __DIR__ . '/../../vendor/autoload.php';

if (!class_exists('WP_Error')) {
    final class WP_Error
    {
        public function __construct(public string $code = '') {}
    }
}
