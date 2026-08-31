import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { grantShopifyEmailBonus, storeBalance } from './purchase.js';
import { mergeStoreSettingsObject, storeSettingsJson } from './settings-json.js';

const ClaimEmailBonusBody = z.object({ email: z.string().trim().email() });

/**
 * Handle of the app block staged for insertion, i.e. the filename of
 * `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`
 * minus its extension. Renaming that file silently breaks this deep link —
 * Shopify just opens the editor without staging the block.
 */
const TRYON_BLOCK_HANDLE = 'tryon-button';

/**
 * Deep link into the merchant's live theme editor with our app block staged for
 * insertion into the product template.
 *
 * Deliberately builds a URL instead of asking the Admin API for the theme ID.
 * The obvious implementation — GET /themes.json?role=main — needs the
 * `read_themes` scope, which this app does not request (see `scopes` in
 * apps/shopify-extension/shopify.app.toml). Shopify answers that call with a
 * 403, `shopifyAdminFetch` turns every 403 into SHOPIFY_REAUTH_REQUIRED, and
 * the SPA then bounces the merchant through OAuth — which re-grants the same
 * scope set and 403s again on the next click. An unbreakable loop on the one
 * button new merchants are told to press first.
 *
 * `themes/current` resolves the published theme server-side, so no theme ID is
 * needed. `addAppBlockId` is `{client_id}/{block handle}` and stages the block
 * for insertion; `template=product` and `target=mainSection` tell the editor
 * which template to open and which section to drop it into. This replaced an
 * `activateAppId` app-embed link — app embeds are injected globally by Shopify,
 * app blocks are placed by the merchant, and the two use different parameters.
 */
export function buildThemeEditorDeepLink(shopDomain: string, apiKey: string): string {
  return (
    `https://${shopDomain}/admin/themes/current/editor` +
    `?template=product&addAppBlockId=${apiKey}/${TRYON_BLOCK_HANDLE}&target=mainSection`
  );
}

export async function shopifyOnboardingRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/onboarding/confirm-theme-block',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const settings = mergeStoreSettingsObject(storeSettingsJson(), [], {
        themeBlockConfirmed: true,
      });

      const [updated] = await app.db
        .update(schema.shopifyStores)
        .set({ settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id))
        .returning({ settings: schema.shopifyStores.settings });
      if (!updated) throw new AppError('FORBIDDEN', 403, 'Store not installed');

      return { settings: updated.settings };
    },
  );

  // Dashboard popup: the merchant confirms/edits their contact email in
  // exchange for a one-time bonus. `shopEmail` is auto-captured from
  // `shop.email` at install with no consent behind it — this is the
  // merchant's own explicit opt-in, so it overwrites that column with
  // whatever they typed rather than leaving the two to drift apart.
  app.post(
    '/v1/shopify/onboarding/claim-email-bonus',
    { preHandler: app.requireShopifySession, schema: { body: ClaimEmailBonusBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { email } = req.body as z.infer<typeof ClaimEmailBonusBody>;

      // Settings flag guards the popup (don't ask again); grantShopifyEmailBonus's
      // own external_ref is the real idempotency guard against a double-submit
      // racing this check.
      if (store.settings.emailBonusClaimed) {
        return {
          creditsGranted: 0,
          creditBalance: await storeBalance(app, store.id),
          settings: store.settings,
        };
      }

      const settings = mergeStoreSettingsObject(storeSettingsJson(), [], {
        emailBonusClaimed: true,
        emailBonusClaimedAt: new Date().toISOString(),
      });

      const [updated] = await app.db
        .update(schema.shopifyStores)
        .set({ shopEmail: email, settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id))
        .returning({ settings: schema.shopifyStores.settings });
      if (!updated) throw new AppError('FORBIDDEN', 403, 'Store not installed');

      const { creditsGranted } = await grantShopifyEmailBonus(app, store);
      return {
        creditsGranted,
        creditBalance: await storeBalance(app, store.id),
        settings: updated.settings,
      };
    },
  );

  // Pure string build — no Shopify API call, no token decrypt. See
  // buildThemeEditorDeepLink for why asking the Admin API here is a trap.
  app.get(
    '/v1/shopify/onboarding/theme-editor-url',
    { preHandler: app.requireShopifySession },
    (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      // Not `?? ''`: an empty key builds a link that opens the editor but
      // silently activates nothing, which looks like the extension is broken.
      if (!app.env.SHOPIFY_API_KEY) throw new AppError('CONFIG', 500, 'SHOPIFY_API_KEY missing');
      return { url: buildThemeEditorDeepLink(store.shopDomain, app.env.SHOPIFY_API_KEY) };
    },
  );
}
