// Universal module: usable as a plain <script> (attaches to window) or via
// require() in a Node test, with no build step either way.
((root, factory) => {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TrymeWidgetLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, () => {
  /**
   * WooCommerce's variation form fires found_variation/show_variation with the
   * selected variation's data, including an `image.src`. Falls back to the
   * parent product image before any selection, for a simple product, or when
   * a variation has no image of its own. Getting this wrong sends the wrong
   * garment into the try-on job. See docs/wordpress-plugin-design.md §4.3.
   */
  function resolveVariationImage(fallbackImage, foundVariationPayload) {
    const variationSrc = foundVariationPayload?.image?.src;
    return variationSrc ? variationSrc : fallbackImage;
  }

  /**
   * Normalizes a /v1/dev/tryon or /v1/dev/jobs/:id response into a single UI
   * state. 401/403 map to 'unavailable' with no retry loop — a widget key can
   * be revoked out from under a live storefront at any time. See
   * docs/wordpress-plugin-design.md §4.3.
   */
  function classifyJobResponse(status, body) {
    if (status === 401 || status === 403) {
      return { state: 'unavailable' };
    }
    if ((status === 202 || status === 200) && body && body.status === 'QUEUED') {
      return { state: 'queued' };
    }
    if (status === 200 && body && body.status === 'RUNNING') {
      return { state: 'running' };
    }
    if (status === 200 && body && body.status === 'COMPLETED') {
      return { state: 'completed', imageUrl: body.imageUrl };
    }
    if (status === 200 && body && body.status === 'FAILED') {
      return { state: 'failed', error: body.error };
    }
    return { state: 'unavailable' };
  }

  /**
   * Maps a /v1/dev/tryon failure into shopper-safe copy — the backend's own
   * AppError message is never shown verbatim (it's written for a developer,
   * e.g. raw Zod text), except the one deliberate case below where it's
   * already a clean, deterministic string. Mirrors the equivalent mapping in
   * the Shopify widget (tryon-widget.js's friendlyClientErrorMessage), but
   * against this route's actual shapes: oversized-file is a 400 VALIDATION
   * with a message like "person exceeds the 20MB limit" (apps/api's
   * modules/dev/routes.ts), not Shopify customer-route's 413.
   */
  function friendlyErrorMessage(status, code, backendMessage) {
    if (code === 'RATE_LIMITED') {
      return 'Lots of people are trying this on right now. Please wait a moment and try again.';
    }
    if (code === 'ENQUEUE_FAIL') {
      return "We're experiencing high demand right now. You haven't been charged — please try again in a moment.";
    }
    if (
      status === 400 &&
      typeof backendMessage === 'string' &&
      /exceeds the .*limit/i.test(backendMessage)
    ) {
      const capitalized = backendMessage.charAt(0).toUpperCase() + backendMessage.slice(1);
      return `${capitalized}. Please choose a smaller photo and try again.`;
    }
    return "We couldn't generate your try-on. Please try again with a different photo.";
  }

  return { resolveVariationImage, classifyJobResponse, friendlyErrorMessage };
});
