import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('admin merchant logo upload', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('presigns an upload URL keyed to the merchant', async () => {
    const { merchantId } = await createTestMerchant(app);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantId}/logo/presign`,
      headers: authHeader,
      payload: { contentType: 'image/png' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { uploadUrl: string; logoKey: string };
    expect(body.uploadUrl).toBeTruthy();
    expect(body.logoKey).toBe(`merchant-logo/${merchantId}/logo.jpg`);
  });

  it('re-signs the returned logoUrl on each read, even though logoKey stays fixed', async () => {
    const { merchantId, userId } = await createTestMerchant(app);

    const firstSet = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: authHeader,
      payload: { logoKey: `merchant-logo/${merchantId}/logo.jpg` },
    });
    expect(firstSet.statusCode).toBe(200);

    const firstDetail = await app.inject({
      method: 'GET',
      url: `/admin/users/${userId}`,
      headers: authHeader,
    });
    const firstLogoUrl = (firstDetail.json() as { merchant: { logoUrl: string } }).merchant.logoUrl;
    expect(firstLogoUrl).toContain(`merchant-logo/${merchantId}/logo.jpg`);

    // SigV4's X-Amz-Date has 1-second granularity, so two presigns within the same
    // second are byte-identical — cross a full second boundary to reliably re-sign.
    await new Promise((r) => setTimeout(r, 1100));
    const secondSet = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: authHeader,
      payload: { logoKey: `merchant-logo/${merchantId}/logo.jpg` },
    });
    expect(secondSet.statusCode).toBe(200);

    const secondDetail = await app.inject({
      method: 'GET',
      url: `/admin/users/${userId}`,
      headers: authHeader,
    });
    const secondLogoUrl = (secondDetail.json() as { merchant: { logoUrl: string } }).merchant
      .logoUrl;

    expect(secondLogoUrl).not.toBe(firstLogoUrl);
  });

  it('persists logoKey via the existing PATCH route, and null clears it', async () => {
    const { merchantId } = await createTestMerchant(app);

    const setRes = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: authHeader,
      payload: { logoKey: `merchant-logo/${merchantId}/logo.jpg` },
    });
    expect(setRes.statusCode).toBe(200);

    const [afterSet] = await app.db
      .select({ logoKey: schema.merchants.logoKey })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));
    expect(afterSet?.logoKey).toBe(`merchant-logo/${merchantId}/logo.jpg`);

    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: authHeader,
      payload: { logoKey: null },
    });
    expect(clearRes.statusCode).toBe(200);

    const [afterClear] = await app.db
      .select({ logoKey: schema.merchants.logoKey })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));
    expect(afterClear?.logoKey).toBeNull();
  });
});
