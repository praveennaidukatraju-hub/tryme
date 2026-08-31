/** Fallback per-merchant dev-API job-creation rate when merchants.jobRateLimitPerMin is null. */
export const DEFAULT_JOB_RATE_LIMIT_PER_MIN = 15;

/** Fallback ceiling on QUEUED catalog/saree/saree_mannequin jobs when config:system holds no entry. */
export const DEFAULT_MAX_QUEUE_DEPTH = 50;

/**
 * Tighter per-widget-key request limit than the account-wide 60/min applied to
 * every dev-API key. A widget key sits in public WordPress page source and is
 * expected to be called only by the storefront widget it was issued for, so a
 * lower ceiling bounds the cost of a copied key before the merchant notices and
 * revokes it. Not per-site: the backend only knows which key made a request,
 * not which WordPress site it came from — see docs/wordpress-plugin-design.md §4.2.
 */
export const DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN = 20;
