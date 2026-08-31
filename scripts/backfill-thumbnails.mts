/**
 * Regenerate REAL (small) thumbnails for admin-curated assets.
 *
 * Thumbnail infra already exists (thumbnail_key columns + *.thumb.jpg keys), but the
 * stored thumb objects are full-size copies — nothing ever resized them. This script
 * reads each full image, downscales it with sharp, and overwrites ONLY the thumb key.
 *
 * pose-assets special case: thumbnailKey was set equal to r2Key at import time.
 * This script derives dst = src.replace(ext, '.thumb.jpg'), writes the thumbnail
 * there, then updates model_pose_assets.thumbnail_key in the DB to the new key.
 *
 * SAFETY: never writes r2_key / face_side_r2_key / bg_comfy_r2_key.
 *         Missing/unreadable source objects are skipped + logged (re-upload those).
 *         Idempotent + re-runnable (withoutEnlargement → no-op once small enough).
 *
 * Usage (run on the VPS where MinIO binds 127.0.0.1, with the prod .env loaded):
 *   DRY_RUN=1 pnpm tsx scripts/backfill-thumbnails.mts        # log only, no writes
 *   pnpm tsx scripts/backfill-thumbnails.mts                  # real run
 *   ONLY=poses,faces pnpm tsx scripts/backfill-thumbnails.mts # subset of tables
 *
 * Requires env: DATABASE_URL, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *               R2_BUCKET, (optional) R2_FORCE_PATH_STYLE (default true).
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDb, eq, isNull, schema } from '@tryme/db';
import sharp from 'sharp';

const THUMB_MAX = 512;
const THUMB_QUALITY = 78;

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const ONLY = (process.env.ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

type DB = ReturnType<typeof createDb>['db'];

/** Each table maps source-key column → destination (thumb) key column. */
interface TableSpec {
  name: string;
  load: (db: DB) => Promise<{ id: string; src: string | null; dst: string | null }[]>;
  /** Derive a new dst key from src (used when dst must differ from DB value). */
  deriveDst?: (src: string) => string;
  /** Update the DB row with the final dst key written (only called when deriveDst present). */
  updateRow?: (db: DB, id: string, newDst: string) => Promise<void>;
}

const SPECS: TableSpec[] = [
  {
    name: 'faces',
    load: async (db) =>
      (await db.select().from(schema.modelFaces)).map((r) => ({
        id: r.id,
        src: r.r2Key,
        dst: r.thumbnailKey,
      })),
    deriveDst: (src) => src.replace(/(\.[^.]+)?$/, '.thumb.jpg'),
    updateRow: async (db, id, newDst) => {
      await db
        .update(schema.modelFaces)
        .set({ thumbnailKey: newDst })
        .where(eq(schema.modelFaces.id, id));
    },
  },
  {
    name: 'backgrounds',
    load: async (db) =>
      (await db.select().from(schema.modelBackgrounds)).map((r) => ({
        id: r.id,
        src: r.r2Key,
        dst: r.thumbnailKey,
      })),
    deriveDst: (src) => src.replace(/(\.[^.]+)?$/, '.thumb.jpg'),
    updateRow: async (db, id, newDst) => {
      await db
        .update(schema.modelBackgrounds)
        .set({ thumbnailKey: newDst })
        .where(eq(schema.modelBackgrounds.id, id));
    },
  },
  {
    name: 'poses',
    load: async (db) =>
      (await db.select().from(schema.modelPoses)).map((r) => ({
        id: r.id,
        src: r.r2Key,
        dst: r.thumbnailKey,
      })),
  },
  {
    name: 'pose-assets',
    load: async (db) =>
      (await db.select().from(schema.modelPoseAssets)).map((r) => ({
        id: r.id,
        src: r.r2Key,
        dst: r.thumbnailKey,
      })),
    // thumbnailKey was set equal to r2Key at import time — derive a separate thumb key
    deriveDst: (src) => src.replace(/(\.[^.]+)?$/, '.thumb.jpg'),
    updateRow: async (db, id, newDst) => {
      await db
        .update(schema.modelPoseAssets)
        .set({ thumbnailKey: newDst })
        .where(eq(schema.modelPoseAssets.id, id));
    },
  },
  {
    name: 'catalog',
    load: async (db) =>
      (await db.select().from(schema.catalogItems)).map((r) => ({
        id: r.id,
        src: r.r2Key,
        dst: r.thumbnailKey,
      })),
  },
  {
    // No full key exists for subcategories — the thumb key IS the only image.
    // Resize in place; withoutEnlargement keeps it idempotent.
    name: 'subcategories',
    load: async (db) =>
      (await db.select().from(schema.garmentSubcategories)).map((r) => ({
        id: r.id,
        src: r.thumbnailKey,
        dst: r.thumbnailKey,
      })),
  },
  {
    // Same shape as subcategories: catalogue template covers have only a single
    // thumbnail_key slot (no separate full-res field), and the admin upload flow
    // was uploading the raw file straight into it until fixed — resize in place.
    name: 'catalogue-templates',
    load: async (db) =>
      (await db.select().from(schema.catalogueTemplates)).map((r) => ({
        id: r.id,
        src: r.thumbnailKey,
        dst: r.thumbnailKey,
      })),
  },
  {
    // Backfill thumbnails for completed job outputs that pre-date the thumbnail feature.
    // New jobs generate thumbnails automatically in the dispatcher.
    // Only processes rows where thumbnail_key IS NULL (skips already-done rows).
    name: 'outputs',
    load: async (db) => {
      const rows = await db
        .select({
          jobId: schema.jobOutputs.jobId,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
        })
        .from(schema.jobOutputs)
        .where(isNull(schema.jobOutputs.thumbnailKey));
      return rows.map((r) => ({
        id: r.jobId,
        src: r.resultKey,
        dst: r.thumbnailKey,
      }));
    },
    deriveDst: (src) =>
      src.replace(/outputs\/([^/]+)\/result\.[^.]+$/, 'outputs/$1/result.thumb.jpg'),
    updateRow: async (db, id, newDst) => {
      await db
        .update(schema.jobOutputs)
        .set({ thumbnailKey: newDst })
        .where(eq(schema.jobOutputs.jobId, id));
    },
  },
];

async function getObjectBytes(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!obj.Body) throw new Error('empty body');
  const bytes = await obj.Body.transformToByteArray();
  return Buffer.from(bytes);
}

function renderBar(done: number, total: number, ok: number, failed: number): void {
  const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
  const filled = Math.floor(pct / 2);
  const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
  process.stderr.write(`\r  [${bar}] ${pct}%  ${done}/${total}  ✓${ok} ✗${failed}  `);
}

async function processTable(spec: TableSpec, db: DB) {
  const rows = await spec.load(db);
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const total = rows.length;

  process.stderr.write(`\n${spec.name} (${total} rows)\n`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.src || !row.dst) {
      skipped++;
      renderBar(i + 1, total, ok, failed);
      continue;
    }
    const finalDst = spec.deriveDst ? spec.deriveDst(row.src) : row.dst;
    try {
      const full = await getObjectBytes(row.src);
      const thumb = await sharp(full)
        .rotate()
        .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY })
        .toBuffer();

      if (DRY_RUN) {
        process.stderr.write(
          `\r[dry] ${spec.name} ${row.id}: ${row.src} (${(full.length / 1024).toFixed(0)}KB) -> ${finalDst} (${(thumb.length / 1024).toFixed(0)}KB)\n`,
        );
      } else {
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: finalDst,
            Body: thumb,
            ContentType: 'image/jpeg',
          }),
        );
        if (spec.updateRow) {
          await spec.updateRow(db, row.id, finalDst);
        }
      }
      ok++;
    } catch (err) {
      failed++;
      process.stderr.write(
        `\n[skip] ${spec.name} ${row.id}: ${row.src} — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    renderBar(i + 1, total, ok, failed);
  }

  process.stderr.write('\n');
  console.log(
    `${spec.name}: ${ok} ok, ${skipped} skipped (no key), ${failed} failed (${total} total)`,
  );
  return { ok, skipped, failed };
}

async function main() {
  const { db, close } = createDb(DATABASE_URL);
  const specs = ONLY.length ? SPECS.filter((s) => ONLY.includes(s.name)) : SPECS;

  console.log(
    `${DRY_RUN ? 'DRY RUN — ' : ''}backfilling thumbnails (max ${THUMB_MAX}px, q${THUMB_QUALITY}) for: ${specs.map((s) => s.name).join(', ')}`,
  );

  const totals = { ok: 0, skipped: 0, failed: 0 };
  try {
    for (const spec of specs) {
      const r = await processTable(spec, db);
      totals.ok += r.ok;
      totals.skipped += r.skipped;
      totals.failed += r.failed;
    }
  } finally {
    await close();
  }

  console.log(
    `\nDONE${DRY_RUN ? ' (dry run — nothing written)' : ''}: ${totals.ok} ok, ${totals.skipped} skipped, ${totals.failed} failed`,
  );
  if (totals.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
