const SHOPIFY_PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/i;

/**
 * Shopify mints a random-subdomain https://{token}.shopifypreview.com origin per
 * theme-preview session, so it can never be pre-registered in shopify_stores.allowedOrigins.
 * Trusting the suffix here is safe: it only widens the CORS/origin gate, actual
 * authorization still requires a valid X-Widget-Key resolving to an active store.
 */
export function isShopifyPreviewOrigin(origin: string): boolean {
  return SHOPIFY_PREVIEW_ORIGIN_RE.test(origin);
}
