/**
 * Seed garment_subcategories from seed-images/garment types/.
 *
 * Layout (flat, no subfolders):
 *   seed-images/garment types/
 *     boy|girl|men|women/*.jpg   -> one garment_subcategories row per file
 *
 * garment_subcategories has no full-size r2_key column — thumbnail_key is the
 * only image, so each file gets exactly one upload (resized).
 *
 * defaultLowerCatalogId / defaultShoeCatalogId / defaultPoseId / tryonCategoryId /
 * instructionImageKey / requiresLowerUpload are left at their defaults (null /
 * false) — set those per garment type from the admin Garment Types page.
 *
 * Idempotent: re-running skips any (genderSlug, slug) already in the DB.
 *
 * Usage:
 *   pnpm seed:garment-types
 *   DRY_RUN=1 pnpm seed:garment-types
 *   ONLY=men,women pnpm seed:garment-types   (folder names: boy, girl, men, women)
 *
 * Requires env: DATABASE_URL, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDb, schema } from '@tryme/db';
import sharp from 'sharp';

const THUMB_MAX = 480;
const THUMB_QUALITY = 80;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// seed-images folder name -> DB genderSlug (GenderSlug = 'men' | 'women' | 'boys' | 'girls')
const FOLDER_TO_GENDER = { men: 'men', women: 'women', boy: 'boys', girl: 'girls' } as const;
type FolderName = keyof typeof FOLDER_TO_GENDER;
const FOLDERS = Object.keys(FOLDER_TO_GENDER) as FolderName[];

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

const ROOT = path.resolve(process.cwd(), 'seed-images', 'garment types');

function subcategoryThumb(id: string) {
  return `models/subcategories/${id}.thumb.jpg`;
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
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

async function main() {
  console.log(`Seeding garment types from ${ROOT}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  const { db, close } = createDb(DATABASE_URL);

  const existingRows = await db
    .select({
      genderSlug: schema.garmentSubcategories.genderSlug,
      slug: schema.garmentSubcategories.slug,
    })
    .from(schema.garmentSubcategories);
  const existing = new Set(existingRows.map((r) => `${r.genderSlug}::${r.slug}`));

  for (const folder of FOLDERS) {
    if (ONLY.size > 0 && !ONLY.has(folder)) continue;
    const genderSlug = FOLDER_TO_GENDER[folder];
    const dir = path.join(ROOT, folder);
    const files = listImageFiles(dir);
    console.log(`\n== ${folder} (-> ${genderSlug}) ==`);
    let sortOrder = 0;
    for (const file of files) {
      done++;
      const label = titleCase(labelFromFilename(file));
      const slug = slugify(label);
      const dedupeKey = `${genderSlug}::${slug}`;
      if (existing.has(dedupeKey)) {
        skipped++;
        renderBar(folder);
        continue;
      }
      try {
        const buf = readFileSync(path.join(dir, file));
        const id = randomUUID();
        const thumbnailKey = subcategoryThumb(id);
        await uploadThumb(thumbnailKey, buf);
        if (!DRY_RUN) {
          await db.insert(schema.garmentSubcategories).values({
            id,
            genderSlug,
            slug,
            label,
            thumbnailKey,
            sortOrder: sortOrder++,
          });
        }
        existing.add(dedupeKey);
        uploaded++;
      } catch (err) {
        failed++;
        process.stderr.write(
          `\n[skip] garment-types/${folder}/${file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      renderBar(folder);
    }
    process.stderr.write('\n');
  }

  await close();
  console.log(
    `\nDone. seen=${done} uploaded=${uploaded} skipped(existing)=${skipped} failed=${failed}`,
  );
}

main().catch((err) => {
  console.error('seed-garment-types failed:', err);
  process.exit(1);
});
