<?php
declare(strict_types=1);

/**
 * Runs only on actual plugin deletion from wp-admin (not on deactivation).
 * Mirrors Tryme_Connection_Settings::clear() — kept as a plain
 * delete_option() rather than loading that class, since uninstall.php runs
 * standalone and none of the plugin's includes are guaranteed loaded here.
 */
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('tryme_tryon_settings');
