import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No testcontainers in this repo (abandoned over MinIO startup issues on Windows —
// see CLAUDE.md Testing section). Reuses the docker-compose Postgres on localhost,
// same as apps/api's integration tests, via a throwaway per-run database.
const pgPort = process.env.POSTGRES_PORT ?? '5432';
const pgUser = process.env.POSTGRES_USER ?? 'tryon';
const pgPassword = process.env.POSTGRES_PASSWORD ?? 'tryon_dev_pw';
const pgDb = process.env.POSTGRES_DB ?? 'tryon_dev';
const dbName = `test_db_schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let db: ReturnType<typeof drizzle>;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  const adminUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${pgDb}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  sql = postgres(`postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${dbName}`);
  db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '../src/migrations') });
}, 60_000);

afterAll(async () => {
  await sql.end();
  const adminUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${pgDb}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
});

describe('model_faces', () => {
  it('inserts and retrieves a face', async () => {
    const [face] = await db
      .insert(schema.modelFaces)
      .values({
        gender: 'men',
        label: 'Test Face',
        r2Key: 'faces/test.jpg',
        thumbnailKey: 'faces/test_thumb.jpg',
      })
      .returning();

    expect(face.id).toBeTruthy();
    expect(face.gender).toBe('men');
    expect(face.isActive).toBe(true);
  });
});

describe('model_backgrounds (global)', () => {
  it('inserts background without faceId', async () => {
    const [bg] = await db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Studio White',
        r2Key: 'backgrounds/studio_white.jpg',
        thumbnailKey: 'backgrounds/studio_white_thumb.jpg',
      })
      .returning();

    expect(bg.id).toBeTruthy();
    expect(bg.label).toBe('Studio White');
    // no faceId column
    expect((bg as unknown as Record<string, unknown>).faceId).toBeUndefined();
  });
});

describe('garment_subcategories', () => {
  it('inserts a garment subcategory', async () => {
    const [sub] = await db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: 'fullsleeveshirt',
        label: 'Full Sleeve Shirt',
      })
      .returning();

    expect(sub.id).toBeTruthy();
    expect(sub.genderSlug).toBe('men');
    expect(sub.slug).toBe('fullsleeveshirt');
    expect(sub.isActive).toBe(true);
  });
});

describe('model_pose_assets + pose_garment_configs (per-subcategory override)', () => {
  it('inserts a pose asset and a garment-config override linked to a subcategory', async () => {
    const [sub] = await db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: 'tshirt',
        label: 'T-Shirt',
      })
      .returning();

    const [pose] = await db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'm1p1',
        r2Key: 'poses/m1p1.jpg',
        thumbnailKey: 'poses/m1p1_thumb.jpg',
      })
      .returning();

    const [config] = await db
      .insert(schema.poseGarmentConfigs)
      .values({
        poseAssetId: pose.id,
        subcategoryId: sub.id,
      })
      .returning();

    expect(pose.id).toBeTruthy();
    expect(pose.isActive).toBe(true);
    expect(config.poseAssetId).toBe(pose.id);
    expect(config.subcategoryId).toBe(sub.id);
  });

  it('rejects a garment config with non-existent subcategory_id', async () => {
    const [pose] = await db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'FK Test Pose',
        r2Key: 'poses/fk_test.jpg',
        thumbnailKey: 'poses/fk_test_thumb.jpg',
      })
      .returning();

    await expect(
      db.insert(schema.poseGarmentConfigs).values({
        poseAssetId: pose.id,
        subcategoryId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow();
  });

  it('rejects a garment config with non-existent pose_asset_id', async () => {
    const [sub] = await db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: 'hoodie',
        label: 'Hoodie',
      })
      .returning();

    await expect(
      db.insert(schema.poseGarmentConfigs).values({
        poseAssetId: '00000000-0000-0000-0000-000000000000',
        subcategoryId: sub.id,
      }),
    ).rejects.toThrow();
  });
});

describe('catalogue_templates + catalogue_template_looks', () => {
  it('inserts a template and a (pose, background) look within it', async () => {
    const [bg] = await db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Outdoor',
        r2Key: 'backgrounds/outdoor.jpg',
        thumbnailKey: 'backgrounds/outdoor_thumb.jpg',
      })
      .returning();

    const [pose] = await db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Template Pose',
        r2Key: 'poses/tmpl.jpg',
        thumbnailKey: 'poses/tmpl_thumb.jpg',
      })
      .returning();

    const [tmpl] = await db
      .insert(schema.catalogueTemplates)
      .values({
        genderSlug: 'men',
        label: 'Polo Template',
      })
      .returning();

    const [look] = await db
      .insert(schema.catalogueTemplateLooks)
      .values({
        templateId: tmpl.id,
        poseAssetId: pose.id,
        backgroundId: bg.id,
      })
      .returning();

    expect(tmpl.isActive).toBe(true);
    expect(look.templateId).toBe(tmpl.id);
    expect(look.poseAssetId).toBe(pose.id);
    expect(look.backgroundId).toBe(bg.id);
  });

  it('rejects a look with non-existent pose_asset_id', async () => {
    const [bg] = await db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Test BG',
        r2Key: 'backgrounds/test.jpg',
        thumbnailKey: 'backgrounds/test_thumb.jpg',
      })
      .returning();

    const [tmpl] = await db
      .insert(schema.catalogueTemplates)
      .values({
        genderSlug: 'women',
        label: 'Dress Template',
      })
      .returning();

    await expect(
      db.insert(schema.catalogueTemplateLooks).values({
        templateId: tmpl.id,
        poseAssetId: '00000000-0000-0000-0000-000000000000',
        backgroundId: bg.id,
      }),
    ).rejects.toThrow();
  });
});
