import { schema } from '@tryme/db';
import { ShopifyStoreSettingsPatch } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { mergeStoreSettingsObject, storeSettingsJson } from './settings-json.js';

export async function shopifySettingsRoutes(app: FastifyInstance) {
  app.patch(
    '/v1/shopify/settings',
    { preValidation: app.requireShopifySession, schema: { body: ShopifyStoreSettingsPatch } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const body = req.body as ShopifyStoreSettingsPatch;

      // Merge in Postgres so a concurrent widget or onboarding update cannot
      // turn this request-start snapshot into a full JSONB replacement.
      let settings = storeSettingsJson();
      if (body.limits) settings = mergeStoreSettingsObject(settings, ['limits'], body.limits);
      if (body.retention)
        settings = mergeStoreSettingsObject(settings, ['retention'], body.retention);

      const [updated] = await app.db
        .update(schema.shopifyStores)
        .set({ settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id))
        .returning({ settings: schema.shopifyStores.settings });
      if (!updated) throw new AppError('FORBIDDEN', 403, 'Store not installed');

      req.log.info(
        { storeId: store.id, changed: Object.keys(body) },
        'shopify store settings updated',
      );
      return { settings: updated.settings };
    },
  );
}
