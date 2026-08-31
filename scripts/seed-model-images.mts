/**
 * Seed model_faces, model_pose_assets, catalog_items (lower/shoe), and
 * model_backgrounds from the local image dump in seed-images/.
 *
 * Expected layout (folder names are read dynamically except the fixed
 * per-gender four: faces/footwear/lowergarments/poses):
 *
 *   seed-images/
 *     men|women|boys|girls/
 *       faces/*.png                      -> one model_faces row per file
 *       poses/<variant>/*.jpg            -> one model_pose_assets row per file
 *       footwear/<style>/*.png           -> one catalog_items row (type=shoe) per file
 *       lowergarments/<style>/*.png      -> one catalog_items row (type=lower) per file
 *     backgrounds/
 *       indoor|nature|outdoor|plain/*.png -> one model_backgrounds row per file
 *
 * Each <style> subfolder under footwear/lowergarments becomes a child
 * catalog_categories row nested under the existing seeded gender-parent
 * category (e.g. "men-shoe"). workflowTemplateId is left null for poses —
 * assign it from the admin Workflows page afterward.
 *
 * Idempotent: re-running skips any (gender, label) combo already in the DB,
 * so you can drop more files into the same folders later and re-run safely.
 *
 * Usage:
 *   pnpm seed:model-images                  # full run
 *   DRY_RUN=1 pnpm seed:model-images         # log only, no uploads/inserts
 *   ONLY=men,backgrounds pnpm seed:model-images  # subset (gender names or "backgrounds")
 *
 * Requires env: DATABASE_URL, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDb, eq, schema } from '@tryme/db';
import sharp from 'sharp';

const THUMB_MAX = 480;
const THUMB_QUALITY = 80;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const GENDERS = ['men', 'women', 'boys', 'girls'] as const;
type Gender = (typeof GENDERS)[number];

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const ONLY = new Set(
  (process.env.ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const DATABASE_URL = requireEnv('DATABASE_URL');
const BUCKET = requireEnv('R2_BUCKET');

const s3 = new S3Client({
  endpoint: requireEnv('R2_ENDPOINT'),
  region: 'auto',
  credentials: {
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: process.env.R2_FORCE_PATH_STYLE !== 'false',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const ROOT = path.resolve(process.cwd(), 'seed-images');

const keys = {
  modelFace: (id: string) => `models/faces/${id}.jpg`,
  modelFaceThumb: (id: string) => `models/faces/${id}.thumb.jpg`,
  modelBackground: (id: string) => `models/backgrounds/${id}.jpg`,
  modelBackgroundThumb: (id: string) => `models/backgrounds/${id}.thumb.jpg`,
  modelPose: (id: string) => `models/pose-assets/${id}.jpg`,
  modelPoseThumb: (id: string) => `models/pose-assets/${id}.thumb.jpg`,
  catalogItem: (typeSlug: string, id: string) => `catalog/${typeSlug}/${id}.jpg`,
  catalogThumb: (typeSlug: string, id: string) => `catalog/${typeSlug}/${id}.thumb.jpg`,
};

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listImageFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && IMAGE_EXT.has(path.extname(d.name).toLowerCase()))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function labelFromFilename(filename: string): string {
  return path.basename(filename, path.extname(filename)).trim();
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function styleLabel(folderName: string): string {
  return titleCase(folderName.replace(/^\d+[-\s]+/, ''));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function uploadFull(key: string, buf: Buffer, contentType: string): Promise<void> {
  if (DRY_RUN) return;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }),
  );
}

async function uploadThumb(key: string, buf: Buffer): Promise<void> {
  const thumb = await sharp(buf)
    .rotate()
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();
  if (DRY_RUN) return;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: thumb, ContentType: 'image/jpeg' }),
  );
}

let done = 0;
let uploaded = 0;
let skipped = 0;
let failed = 0;

function renderBar(section: string) {
  process.stderr.write(
    `\r  ${section}: ${done} seen, ${uploaded} uploaded, ${skipped} skipped, ${failed} failed  `,
  );
}

type DB = ReturnType<typeof createDb>['db'];

async function seedFaces(db: DB, gender: Gender, existing: Set<string>) {
  const dir = path.join(ROOT, gender, 'faces');
  const files = listImageFiles(dir);
  let sortOrder = 0;
  for (const file of files) {
    done++;
    const label = labelFromFilename(file);
    const dedupeKey = `${gender}::${label}`;
    if (existing.has(dedupeKey)) {
      skipped++;
      renderBar(`faces/${gender}`);
      continue;
    }
    try {
      const buf = readFileSync(path.join(dir, file));
      const id = randomUUID();
      const r2Key = keys.modelFace(id);
      const thumbnailKey = keys.modelFaceThumb(id);
      await uploadFull(r2Key, buf, contentTypeFor(file));
      await uploadThumb(thumbnailKey, buf);
      if (!DRY_RUN) {
        await db
          .insert(schema.modelFaces)
          .values({ id, gender, label, r2Key, thumbnailKey, sortOrder: sortOrder++ });
      }
      existing.add(dedupeKey);
      uploaded++;
    } catch (err) {
      failed++;
      process.stderr.write(
        `\n[skip] faces/${gender}/${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    renderBar(`faces/${gender}`);
  }
  process.stderr.write('\n');
}

async function seedPoses(db: DB, gender: Gender, existing: Set<string>) {
  const baseDir = path.join(ROOT, gender, 'poses');
  const variants = listDirs(baseDir);
  let sortOrder = 0;
  for (const variant of variants) {
    const dir = path.join(baseDir, variant);
    const poseVariant = variant.toLowerCase().trim();
    for (const file of listImageFiles(dir)) {
      done++;
      const label = labelFromFilename(file);
      const dedupeKey = `${gender}::${poseVariant}::${label}`;
      if (existing.has(dedupeKey)) {
        skipped++;
        renderBar(`poses/${gender}`);
        continue;
      }
      try {
        const buf = readFileSync(path.join(dir, file));
        const id = randomUUID();
        const r2Key = keys.modelPose(id);
        const thumbnailKey = keys.modelPoseThumb(id);
        await uploadFull(r2Key, buf, contentTypeFor(file));
        await uploadThumb(thumbnailKey, buf);
        if (!DRY_RUN) {
          await db.insert(schema.modelPoseAssets).values({
            id,
            label,
            displayName: label,
            poseVariant,
            genderSlug: gender,
            r2Key,
            thumbnailKey,
            sortOrder: sortOrder++,
          });
        }
        existing.add(dedupeKey);
        uploaded++;
      } catch (err) {
        failed++;
        process.stderr.write(
          `\n[skip] poses/${gender}/${variant}/${file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      renderBar(`poses/${gender}`);
    }
  }
  process.stderr.write('\n');
}

async function seedBackgrounds(db: DB, existing: Set<string>) {
  const baseDir = path.join(ROOT, 'backgrounds');
  const groups = listDirs(baseDir);
  let sortOrder = 0;
  for (const group of groups) {
    const dir = path.join(baseDir, group);
    const tag = group.toLowerCase().trim();
    const files = listImageFiles(dir);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      done++;
      const label = tag === 'plain' ? labelFromFilename(file) : `${titleCase(group)} ${i + 1}`;
      const dedupeKey = `${tag}::${label}`;
      if (existing.has(dedupeKey)) {
        skipped++;
        renderBar('backgrounds');
        continue;
      }
      try {
        const buf = readFileSync(path.join(dir, file));
        const id = randomUUID();
        const r2Key = keys.modelBackground(id);
        const thumbnailKey = keys.modelBackgroundThumb(id);
        await uploadFull(r2Key, buf, contentTypeFor(file));
        await uploadThumb(thumbnailKey, buf);
        if (!DRY_RUN) {
          await db.insert(schema.modelBackgrounds).values({
            id,
            label,
            r2Key,
            thumbnailKey,
            tags: [tag],
            sortOrder: sortOrder++,
          });
        }
        existing.add(dedupeKey);
        uploaded++;
      } catch (err) {
        failed++;
        process.stderr.write(
          `\n[skip] backgrounds/${group}/${file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      renderBar('backgrounds');
    }
  }
  process.stderr.write('\n');
}

const categoryCache = new Map<string, { id: number; typeId: number }>();

const typeIdCache = new Map<string, number>();

async function getCatalogTypeId(db: DB, typeSlug: 'lower' | 'shoe'): Promise<number> {
  const cached = typeIdCache.get(typeSlug);
  if (cached) return cached;
  const [row] = await db
    .select({ id: schema.catalogTypes.id })
    .from(schema.catalogTypes)
    .where(eq(schema.catalogTypes.slug, typeSlug));
  if (!row) throw new Error(`catalog_types row "${typeSlug}" not found — run pnpm db:migrate`);
  typeIdCache.set(typeSlug, row.id);
  return row.id;
}

// migration 0006 is supposed to pre-seed one gender-parent category per (type, gender),
// but that's been observed missing on some local DBs — self-heal by creating it here too.
async function getGenderParentCategory(db: DB, typeSlug: 'lower' | 'shoe', gender: Gender) {
  const cacheKey = `parent::${typeSlug}::${gender}`;
  const cached = categoryCache.get(cacheKey);
  if (cached) return cached;
  const slug = `${gender}-${typeSlug}`;
  const [row] = await db
    .select({ id: schema.catalogCategories.id, typeId: schema.catalogCategories.typeId })
    .from(schema.catalogCategories)
    .where(eq(schema.catalogCategories.slug, slug));
  if (row) {
    categoryCache.set(cacheKey, row);
    return row;
  }
  const typeId = await getCatalogTypeId(db, typeSlug);
  if (DRY_RUN) {
    const fake = { id: -1, typeId };
    categoryCache.set(cacheKey, fake);
    return fake;
  }
  const [created] = await db
    .insert(schema.catalogCategories)
    .values({
      typeId,
      parentId: null,
      slug,
      label: titleCase(gender),
      genderSlug: gender,
      sortOrder: 0,
    })
    .returning({ id: schema.catalogCategories.id, typeId: schema.catalogCategories.typeId });
  if (!created) throw new Error(`category insert returned no row for ${slug}`);
  categoryCache.set(cacheKey, created);
  return created;
}

async function getOrCreateChildCategory(
  db: DB,
  typeSlug: 'lower' | 'shoe',
  gender: Gender,
  folderName: string,
  sortOrder: number,
): Promise<{ id: number }> {
  const label = styleLabel(folderName);
  const slug = `${gender}-${typeSlug}-${slugify(label)}`;
  const cacheKey = `child::${slug}`;
  const cached = categoryCache.get(cacheKey);
  if (cached) return cached;

  const [existingRow] = await db
    .select({ id: schema.catalogCategories.id, typeId: schema.catalogCategories.typeId })
    .from(schema.catalogCategories)
    .where(eq(schema.catalogCategories.slug, slug));
  if (existingRow) {
    categoryCache.set(cacheKey, existingRow);
    return existingRow;
  }

  const parent = await getGenderParentCategory(db, typeSlug, gender);
  if (DRY_RUN) {
    const fake = { id: -1, typeId: parent.typeId };
    categoryCache.set(cacheKey, fake);
    return fake;
  }
  const [created] = await db
    .insert(schema.catalogCategories)
    .values({
      typeId: parent.typeId,
      parentId: parent.id,
      slug,
      label,
      genderSlug: gender,
      sortOrder,
    })
    .returning({ id: schema.catalogCategories.id, typeId: schema.catalogCategories.typeId });
  if (!created) throw new Error(`category insert returned no row for ${slug}`);
  categoryCache.set(cacheKey, created);
  return created;
}

async function seedCatalogGroup(
  db: DB,
  typeSlug: 'lower' | 'shoe',
  gender: Gender,
  folderKind: 'footwear' | 'lowergarments',
  existing: Set<string>,
) {
  const baseDir = path.join(ROOT, gender, folderKind);
  const styleFolders = listDirs(baseDir);
  let categorySort = 0;
  for (const folder of styleFolders) {
    const dir = path.join(baseDir, folder);
    const label = styleLabel(folder);
    const files = listImageFiles(dir);
    if (files.length === 0) continue;
    const category = await getOrCreateChildCategory(db, typeSlug, gender, folder, categorySort++);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      done++;
      const itemLabel = `${label} ${i + 1}`;
      const dedupeKey = `${typeSlug}::${gender}::${label}::${itemLabel}`;
      if (existing.has(dedupeKey)) {
        skipped++;
        renderBar(`${folderKind}/${gender}`);
        continue;
      }
      try {
        const buf = readFileSync(path.join(dir, file));
        const id = randomUUID();
        const r2Key = keys.catalogItem(typeSlug, id);
        const thumbnailKey = keys.catalogThumb(typeSlug, id);
        await uploadFull(r2Key, buf, contentTypeFor(file));
        await uploadThumb(thumbnailKey, buf);
        if (!DRY_RUN) {
          await db.insert(schema.catalogItems).values({
            id,
            categoryId: category.id,
            type: typeSlug,
            genderSlug: gender,
            label: itemLabel,
            r2Key,
            thumbnailKey,
            sortOrder: i,
          });
        }
        existing.add(dedupeKey);
        uploaded++;
      } catch (err) {
        failed++;
        process.stderr.write(
          `\n[skip] ${folderKind}/${gender}/${folder}/${file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      renderBar(`${folderKind}/${gender}`);
    }
  }
  process.stderr.write('\n');
}

async function main() {
  console.log(`Seeding model images from ${ROOT}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  const { db, close } = createDb(DATABASE_URL);

  const [existingFaces, existingPoses, existingBg, existingItems] = await Promise.all([
    db
      .select({ gender: schema.modelFaces.gender, label: schema.modelFaces.label })
      .from(schema.modelFaces),
    db
      .select({
        genderSlug: schema.modelPoseAssets.genderSlug,
        poseVariant: schema.modelPoseAssets.poseVariant,
        label: schema.modelPoseAssets.label,
      })
      .from(schema.modelPoseAssets),
    db
      .select({ label: schema.modelBackgrounds.label, tags: schema.modelBackgrounds.tags })
      .from(schema.modelBackgrounds),
    db
      .select({
        type: schema.catalogItems.type,
        genderSlug: schema.catalogItems.genderSlug,
        label: schema.catalogItems.label,
        categoryId: schema.catalogItems.categoryId,
      })
      .from(schema.catalogItems),
  ]);

  const facesSeen = new Set(existingFaces.map((r) => `${r.gender}::${r.label}`));
  const posesSeen = new Set(
    existingPoses.map((r) => `${r.genderSlug}::${r.poseVariant}::${r.label}`),
  );
  const bgSeen = new Set(existingBg.map((r) => `${r.tags?.[0] ?? ''}::${r.label}`));

  // catalog items are deduped by (type, gender, category label, item label) — but the
  // loaded rows only give categoryId, not the folder label, so build the set lazily by
  // querying category labels for the ids present.
  const categoryLabelById = new Map<number, string>();
  if (existingItems.length > 0) {
    const rows = await db
      .select({ id: schema.catalogCategories.id, label: schema.catalogCategories.label })
      .from(schema.catalogCategories);
    for (const r of rows) categoryLabelById.set(r.id, r.label);
  }
  const itemsSeen = new Set(
    existingItems.map(
      (r) =>
        `${r.type}::${r.genderSlug}::${r.categoryId ? categoryLabelById.get(r.categoryId) : ''}::${r.label}`,
    ),
  );

  for (const gender of GENDERS) {
    if (ONLY.size > 0 && !ONLY.has(gender)) continue;
    console.log(`\n== ${gender} ==`);
    await seedFaces(db, gender, facesSeen);
    await seedPoses(db, gender, posesSeen);
    await seedCatalogGroup(db, 'shoe', gender, 'footwear', itemsSeen);
    await seedCatalogGroup(db, 'lower', gender, 'lowergarments', itemsSeen);
  }

  if (ONLY.size === 0 || ONLY.has('backgrounds')) {
    console.log('\n== backgrounds ==');
    await seedBackgrounds(db, bgSeen);
  }

  await close();
  console.log(
    `\nDone. seen=${done} uploaded=${uploaded} skipped(existing)=${skipped} failed=${failed}`,
  );
}

main().catch((err) => {
  console.error('seed-model-images failed:', err);
  process.exit(1);
});
