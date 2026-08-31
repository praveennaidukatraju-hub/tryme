import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { and, count, eq, ilike, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { assertShopifyCdn } from './products.sync.js';
import { numericIdFromGid, shopifyGraphQL, toGid } from './service.js';
import { getValidAccessToken } from './token.js';

const queryBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

const ProductsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  enabled: queryBoolean,
  excluded: queryBoolean,
  status: z.enum(['active', 'processing', 'failed', 'deleted']).optional(),
  q: z.string().optional(),
});

const PatchProductBody = z
  .object({
    enabled: z.boolean().optional(),
    excluded: z.boolean().optional(),
    garmentImageUrl: z.string().url().optional(),
  })
  .refine(
    (b) => b.enabled !== undefined || b.excluded !== undefined || b.garmentImageUrl !== undefined,
    { message: 'at least one of enabled, excluded, or garmentImageUrl is required' },
  );

const PRODUCT_IMAGES = `
  query ProductImages($id: ID!) {
    product(id: $id) {
      images(first: 250) { nodes { id url } }
    }
  }
`;

interface ProductImagesData {
  product: { images: { nodes: Array<{ id: string; url: string }> } } | null;
}

export async function fetchLiveProductImages(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  shopifyProductId: string,
): Promise<{ id: number; src: string }[]> {
  const token = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<ProductImagesData>(store.shopDomain, token, PRODUCT_IMAGES, {
    id: toGid('Product', shopifyProductId),
  });
  if (!data.product) {
    throw new AppError('SHOPIFY', 502, 'failed to fetch product images');
  }
  const images = data.product.images.nodes;
  // Still guarded before any of these URLs is handed to a downloader.
  for (const img of images) assertShopifyCdn(img.url);
  return images.map((img) => ({ id: numericIdFromGid(img.id), src: img.url }));
}

export async function shopifyProductsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/shopify/products',
    { preHandler: app.requireShopifySession, schema: { querystring: ProductsQuery } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { page, pageSize, enabled, excluded, status, q } = req.query as z.infer<
        typeof ProductsQuery
      >;

      const conditions = [eq(schema.shopifyProductGarments.storeId, store.id)];
      conditions.push(
        status
          ? eq(schema.shopifyProductGarments.status, status)
          : ne(schema.shopifyProductGarments.status, 'deleted'),
      );
      if (enabled !== undefined)
        conditions.push(eq(schema.shopifyProductGarments.enabled, enabled));
      if (excluded !== undefined)
        conditions.push(eq(schema.shopifyProductGarments.excluded, excluded));
      if (q) conditions.push(ilike(schema.shopifyProductGarments.title, `%${q}%`));
      const where = and(...conditions);

      const [{ total }] = await app.db
        .select({ total: count() })
        .from(schema.shopifyProductGarments)
        .where(where);

      const rows = await app.db
        .select({
          shopifyProductId: schema.shopifyProductGarments.shopifyProductId,
          title: schema.shopifyProductGarments.title,
          r2Key: schema.shopifyProductGarments.r2Key,
          status: schema.shopifyProductGarments.status,
          enabled: schema.shopifyProductGarments.enabled,
          excluded: schema.shopifyProductGarments.excluded,
        })
        .from(schema.shopifyProductGarments)
        .where(where)
        .orderBy(schema.shopifyProductGarments.shopifyProductId)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const items = await Promise.all(
        rows.map(async (r) => ({
          shopifyProductId: r.shopifyProductId,
          title: r.title,
          thumbnailUrl: (await app.storage.presignGet(r.r2Key, 3600)).url,
          status: r.status,
          enabled: r.enabled,
          excluded: r.excluded,
        })),
      );

      return { page, pageSize, total, items };
    },
  );

  app.get(
    '/v1/shopify/products/:id/images',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };
      const images = await fetchLiveProductImages(app, store, id);
      return { images };
    },
  );

  app.patch(
    '/v1/shopify/products/:id',
    { preHandler: app.requireShopifySession, schema: { body: PatchProductBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };
      const shopifyProductId = Number(id);
      const { enabled, excluded, garmentImageUrl } = req.body as z.infer<typeof PatchProductBody>;

      const [existing] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, store.id),
            eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
          ),
        )
        .limit(1);
      if (!existing) throw new AppError('NOT_FOUND', 404, 'product not synced yet');

      if (enabled === true && existing.status !== 'active') {
        throw new AppError('BAD_REQUEST', 400, 'cannot enable a product that is not active');
      }

      let newR2Key: string | undefined;
      if (garmentImageUrl) {
        const liveImages = await fetchLiveProductImages(app, store, id);
        const matched = liveImages.some((img) => img.src === garmentImageUrl);
        if (!matched) {
          throw new AppError(
            'BAD_REQUEST',
            400,
            "garmentImageUrl is not one of this product's current images",
          );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let res: Response;
        try {
          res = await fetch(garmentImageUrl, { redirect: 'error', signal: controller.signal });
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') {
            throw new AppError('SHOPIFY', 504, 'timed out downloading the selected image');
          }
          throw err;
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected image');
        const maxProductImageBytes = await getUploadLimitBytes(app, 'shopifyProductImageMaxBytes');
        const contentLength = res.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxProductImageBytes) {
          throw new AppError(
            'BAD_REQUEST',
            400,
            `image exceeds ${maxProductImageBytes / (1024 * 1024)}MB`,
          );
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > maxProductImageBytes) {
          throw new AppError(
            'BAD_REQUEST',
            400,
            `image exceeds ${maxProductImageBytes / (1024 * 1024)}MB`,
          );
        }
        const contentType = res.headers.get('content-type') ?? 'image/jpeg';
        newR2Key = `shopify-garments/${store.id}/${shopifyProductId}/garment-${randomUUID()}.jpg`;
        await app.storage.putObject(newR2Key, Buffer.from(arrayBuffer), contentType);
      }

      const [updated] = await app.db
        .update(schema.shopifyProductGarments)
        .set({
          ...(enabled !== undefined ? { enabled } : {}),
          ...(excluded !== undefined ? { excluded } : {}),
          ...(newR2Key ? { r2Key: newR2Key } : {}),
        })
        .where(eq(schema.shopifyProductGarments.id, existing.id))
        .returning();

      return {
        shopifyProductId: updated.shopifyProductId,
        title: updated.title,
        thumbnailUrl: (await app.storage.presignGet(updated.r2Key, 3600)).url,
        status: updated.status,
        enabled: updated.enabled,
        excluded: updated.excluded,
      };
    },
  );
}
