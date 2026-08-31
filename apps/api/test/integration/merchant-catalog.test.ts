import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(
  app: TestApp,
  email: string,
  overrides: Partial<typeof schema.merchants.$inferInsert> = {},
) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();

  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      websiteUrl: 'https://example.com',
      companySize: '1-10',
      purpose: 'merchant tests',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
      ...overrides,
    })
    .returning();

  return merchant;
}

async function createUser(app: TestApp, email: string) {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email,
      emailVerified: true,
      tier: 'free',
    })
    .returning();

  await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
  return user;
}

async function seedGarmentType(app: TestApp, genderSlug: string) {
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug,
      slug: `type-${randomUUID()}`,
      label: 'Type',
    })
    .returning();
  return row;
}

async function merchantAuthHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function putPresigned(uploadUrl: string, body: Buffer, contentType: string) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
  expect(res.ok).toBe(true);
}

async function createCompletedJob(
  app: TestApp,
  userId: string,
  opts: {
    catalogueId?: string;
    garmentBody: Buffer;
    resultBody: Buffer;
    thumbnailBody?: Buffer;
  },
) {
  const catalogueId = opts.catalogueId ?? randomUUID();
  const [job] = await app.db
    .insert(schema.jobs)
    .values({
      userId,
      catalogueId,
      status: 'COMPLETED',
      completedAt: new Date(),
      creditsCharged: 1,
    })
    .returning();

  const garmentKey = `studio/${job.id}/garment.jpg`;
  const resultKey = keys.output(job.id);
  const thumbnailKey = `studio/${job.id}/thumb.jpg`;

  await Promise.all([
    app.storage.putObject(garmentKey, opts.garmentBody, 'image/jpeg'),
    app.storage.putObject(resultKey, opts.resultBody, 'image/jpeg'),
    app.storage.putObject(thumbnailKey, opts.thumbnailBody ?? opts.resultBody, 'image/jpeg'),
  ]);

  await app.db.insert(schema.jobInputs).values({
    jobId: job.id,
    upperGarmentKey: garmentKey,
    params: { platform: 'studio' },
  });
  await app.db.insert(schema.jobOutputs).values({
    jobId: job.id,
    resultKey,
    thumbnailKey,
  });

  return { job, garmentKey, resultKey, thumbnailKey, catalogueId };
}

describe('merchant catalog', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('presigns, uploads, creates, lists, and isolates merchant-private items', async () => {
    const merchantA = await createMerchant(app, 'merchant-a@example.com');
    const merchantB = await createMerchant(app, 'merchant-b@example.com');
    const authA = await merchantAuthHeader(merchantA.userId);
    const authB = await merchantAuthHeader(merchantB.userId);

    const assetId = randomUUID();
    const imageBody = Buffer.from('merchant-image-a');
    const thumbBody = Buffer.from('merchant-thumb-a');

    const presignImage = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: authA,
      payload: {
        assetId,
        kind: 'image',
        contentType: 'image/jpeg',
        contentLength: imageBody.length,
      },
    });
    expect(presignImage.statusCode).toBe(200);
    const imageUpload = presignImage.json() as {
      uploadUrl: string;
      r2Key: string;
      assetId: string;
    };
    expect(imageUpload.assetId).toBe(assetId);

    const presignThumb = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: authA,
      payload: {
        assetId,
        kind: 'thumbnail',
        contentType: 'image/jpeg',
        contentLength: thumbBody.length,
      },
    });
    expect(presignThumb.statusCode).toBe(200);
    const thumbUpload = presignThumb.json() as { uploadUrl: string; r2Key: string };

    await putPresigned(imageUpload.uploadUrl, imageBody, 'image/jpeg');
    await putPresigned(thumbUpload.uploadUrl, thumbBody, 'image/jpeg');

    const garmentType = await seedGarmentType(app, 'women');
    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: authA,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog',
      headers: authA,
      payload: {
        subcategoryId,
        label: 'Red Saree',
        sku: 'SKU-1',
        actualPrice: 2000,
        offerPrice: 1800,
        r2Key: imageUpload.r2Key,
        thumbnailKey: thumbUpload.r2Key,
      },
    });
    expect(created.statusCode).toBe(201);
    const item = created.json() as {
      id: string;
      merchantId: string;
      subcategoryId: string;
      actualPrice: number;
      offerPrice: number;
      r2Key: string;
      thumbnailKey: string;
      sourceKind: 'uploaded' | 'generated' | 'imported';
    };
    expect(item.merchantId).toBe(merchantA.id);
    expect(item.subcategoryId).toBe(subcategoryId);
    expect(item.actualPrice).toBe(2000);
    expect(item.offerPrice).toBe(1800);
    expect(item.sourceKind).toBe('uploaded');

    const listed = await app.inject({ method: 'GET', url: '/v1/merchant/catalog', headers: authA });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as {
      items: Array<{ id: string; imageUrl: string | null; thumbnailUrl: string | null }>;
    };
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]?.id).toBe(item.id);
    expect(listedBody.items[0]?.imageUrl).toEqual(expect.any(String));
    expect(listedBody.items[0]?.thumbnailUrl).toEqual(expect.any(String));

    const isolatedList = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog',
      headers: authB,
    });
    expect(isolatedList.statusCode).toBe(200);
    expect((isolatedList.json() as { items: unknown[] }).items).toHaveLength(0);

    const crossMerchantPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${item.id}`,
      headers: authB,
      payload: { label: 'Should not work' },
    });
    expect(crossMerchantPatch.statusCode).toBe(404);
  });

  it('imports linked studio jobs by copy, survives source-job deletion, and rejects invalid imports', async () => {
    const linkedUser = await createUser(app, 'studio-linked@example.com');
    const otherUser = await createUser(app, 'studio-other@example.com');

    const linkedMerchant = await createMerchant(app, 'linked-merchant@example.com', {
      userId: linkedUser.id,
    });
    const authLinked = await merchantAuthHeader(linkedMerchant.userId);

    const garmentType = await seedGarmentType(app, 'women');
    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: authLinked,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const garmentBody = Buffer.from('source-garment');
    const resultBody = Buffer.from('source-result');
    const thumbBody = Buffer.from('source-thumb');
    const linkedStudioJob = await createCompletedJob(app, linkedUser.id, {
      catalogueId: randomUUID(),
      garmentBody,
      resultBody,
      thumbnailBody: thumbBody,
    });
    const otherUsersJob = await createCompletedJob(app, otherUser.id, {
      catalogueId: randomUUID(),
      garmentBody: Buffer.from('other-garment'),
      resultBody: Buffer.from('other-result'),
      thumbnailBody: Buffer.from('other-thumb'),
    });

    const cataloguesBefore = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalogues',
      headers: authLinked,
    });
    expect(cataloguesBefore.statusCode).toBe(200);
    const beforeBody = cataloguesBefore.json() as {
      catalogues: Array<{ jobs: Array<{ jobId: string; imported: boolean }> }>;
    };
    expect(beforeBody.catalogues).toHaveLength(1);
    expect(beforeBody.catalogues[0]?.jobs[0]?.jobId).toBe(linkedStudioJob.job.id);
    expect(beforeBody.catalogues[0]?.jobs[0]?.imported).toBe(false);

    const imported = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/import',
      headers: authLinked,
      payload: { jobId: linkedStudioJob.job.id, subcategoryId },
    });
    expect(imported.statusCode).toBe(201);
    const importedItem = imported.json() as {
      id: string;
      r2Key: string;
      thumbnailKey: string;
      sourceJobId: string | null;
      sourceKind: 'uploaded' | 'imported';
    };
    expect(importedItem.sourceJobId).toBe(linkedStudioJob.job.id);
    expect(importedItem.sourceKind).toBe('imported');
    expect(importedItem.r2Key).toMatch(new RegExp(`^merchant-catalog/${linkedMerchant.id}/`));
    expect(importedItem.thumbnailKey).toMatch(
      new RegExp(`^merchant-catalog/${linkedMerchant.id}/`),
    );
    expect(importedItem.r2Key).not.toBe(linkedStudioJob.garmentKey);
    expect(importedItem.thumbnailKey).not.toBe(linkedStudioJob.thumbnailKey);

    const [importedRow] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, importedItem.id));
    expect((await app.storage.getObject(importedRow.r2Key)).equals(resultBody)).toBe(true);
    expect((await app.storage.getObject(importedItem.thumbnailKey)).equals(thumbBody)).toBe(true);

    const cataloguesAfter = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalogues',
      headers: authLinked,
    });
    expect(cataloguesAfter.statusCode).toBe(200);
    const afterBody = cataloguesAfter.json() as {
      catalogues: Array<{ jobs: Array<{ jobId: string; imported: boolean }> }>;
    };
    expect(afterBody.catalogues[0]?.jobs[0]?.imported).toBe(true);

    const duplicateImport = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/import',
      headers: authLinked,
      payload: { jobId: linkedStudioJob.job.id, subcategoryId },
    });
    expect(duplicateImport.statusCode).toBe(409);

    const otherUserImport = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/import',
      headers: authLinked,
      payload: { jobId: otherUsersJob.job.id, subcategoryId },
    });
    expect(otherUserImport.statusCode).toBe(403);

    await app.db.delete(schema.jobs).where(eq(schema.jobs.id, linkedStudioJob.job.id));

    const [persisted] = await app.db
      .select({
        sourceJobId: schema.merchantCatalogItems.sourceJobId,
        r2Key: schema.merchantCatalogItems.r2Key,
      })
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, importedItem.id))
      .limit(1);
    expect(persisted?.sourceJobId).toBeNull();
    expect((await app.storage.getObject(importedItem.r2Key)).equals(resultBody)).toBe(true);

    const catalogAfterDelete = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog',
      headers: authLinked,
    });
    expect(catalogAfterDelete.statusCode).toBe(200);
    const catalogItems = (
      catalogAfterDelete.json() as {
        items: Array<{
          id: string;
          imageUrl: string | null;
          thumbnailUrl: string | null;
          sourceJobId: string | null;
        }>;
      }
    ).items;
    expect(catalogItems).toHaveLength(1);
    expect(catalogItems[0]?.id).toBe(importedItem.id);
    expect(catalogItems[0]?.sourceJobId).toBeNull();
    expect(catalogItems[0]?.imageUrl).toEqual(expect.any(String));
    expect(catalogItems[0]?.thumbnailUrl).toEqual(expect.any(String));

    // biome-ignore lint/style/noNonNullAssertion: presence just asserted above
    const servedImage = await fetch(catalogItems[0]!.imageUrl!);
    expect(servedImage.ok).toBe(true);
    expect(Buffer.from(await servedImage.arrayBuffer()).equals(resultBody)).toBe(true);
  });

  it('stores and serves a second image when provided', async () => {
    async function presignAndPut(
      merchantAuth: Record<string, string>,
      kind: 'image' | 'thumbnail',
      data: Buffer = Buffer.from('test-image'),
    ) {
      const assetId = randomUUID();
      const presign = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/presign',
        headers: merchantAuth,
        payload: {
          assetId,
          kind,
          contentType: 'image/jpeg',
          contentLength: data.length,
        },
      });
      expect(presign.statusCode).toBe(200);
      const upload = presign.json() as { uploadUrl: string; r2Key: string };
      await putPresigned(upload.uploadUrl, data, 'image/jpeg');
      return upload;
    }

    const merchant = await createMerchant(app, 'second-image-merchant@example.com');
    const auth = await merchantAuthHeader(merchant.userId);

    const garmentType = await seedGarmentType(app, 'women');
    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const primary = await presignAndPut(auth, 'image', Buffer.from('primary-body'));
    const primaryThumb = await presignAndPut(auth, 'thumbnail', Buffer.from('primary-thumb'));
    const second = await presignAndPut(auth, 'image', Buffer.from('second-pallu'));
    const secondThumb = await presignAndPut(auth, 'thumbnail', Buffer.from('second-thumb'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog',
      headers: auth,
      payload: {
        subcategoryId,
        label: 'Two-Input Saree',
        sku: 'SKU-2IN',
        actualPrice: 2000,
        offerPrice: 1500,
        r2Key: primary.r2Key,
        thumbnailKey: primaryThumb.r2Key,
        secondR2Key: second.r2Key,
        secondThumbnailKey: secondThumb.r2Key,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      secondR2Key: string | null;
      secondImageUrl: string | null;
      secondThumbnailKey: string | null;
    };
    expect(body.secondR2Key).toBe(second.r2Key);
    expect(body.secondThumbnailKey).toBe(secondThumb.r2Key);
    expect(body.secondImageUrl).toBeTruthy();

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/${body.id}`,
      headers: auth,
    });
    expect(deleteRes.statusCode).toBe(204);
    await expect(app.storage.headObject(second.r2Key)).rejects.toThrow();
    await expect(app.storage.headObject(secondThumb.r2Key)).rejects.toThrow();
  });
});
