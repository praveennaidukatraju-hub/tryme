import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const WATERMARK_VERSION = 1;

let tileBuffer: Buffer | null = null;
let tileWidth = 0;
let tileHeight = 0;

const WATERMARK_LOGO_URL = new URL('../../assets/watermark-logo.svg', import.meta.url);
const WATERMARK_LOGO_PATH = fileURLToPath(WATERMARK_LOGO_URL);
const WATERMARK_OPACITY = 0.26;
const WATERMARK_TILE_SPACING = 160;

/**
 * Initialize the watermark tile. Must be called at startup.
 * Throws if the logo is missing or Sharp fails to init, failing the dispatcher closed.
 */
export async function initWatermarkTile() {
  if (tileBuffer) return;

  const logoBytes = readFileSync(WATERMARK_LOGO_PATH);

  // Pre-render the repeating watermark unit once. The tile itself must stay
  // fully transparent outside the logo; only the composited logo should carry
  // low alpha, otherwise the whole image gets an unintended grey veil.
  const rotatedLogo = await sharp(logoBytes)
    .resize({ width: 200 })
    .rotate(-35, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  // sharp's composite() has no real "opacity" option, so the alpha channel
  // must be scaled by hand before compositing, otherwise the logo always
  // renders fully opaque.
  const { data, info } = await sharp(rotatedLogo)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round((data[i] ?? 0) * WATERMARK_OPACITY);
  }
  const logoBuffer = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();

  const width = info.width;
  const height = info.height;

  tileWidth = width + WATERMARK_TILE_SPACING;
  tileHeight = height + WATERMARK_TILE_SPACING;

  tileBuffer = await sharp({
    create: {
      width: tileWidth,
      height: tileHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: logoBuffer,
        gravity: 'center',
        blend: 'over',
      },
    ])
    .png()
    .toBuffer();
}

/**
 * Deterministic tile offset seeded from jobId, so every image gets a
 * unique-looking layout without re-rendering the pattern geometry.
 */
export function tileOffsetForJob(jobId: string): { x: number; y: number } {
  const hash = createHash('sha256').update(jobId).digest();
  const x = tileWidth > 0 ? hash.readUInt32BE(0) % tileWidth : 0;
  const y = tileHeight > 0 ? hash.readUInt32BE(4) % tileHeight : 0;
  return { x, y };
}

/**
 * Applies the watermark tile across the target image canvas.
 */
export async function applyWatermark(opts: { image: Uint8Array; jobId: string }): Promise<Buffer> {
  if (!tileBuffer) {
    throw new Error('WatermarkService not initialized');
  }

  const { image, jobId } = opts;
  const baseImage = sharp(image);
  const metadata = await baseImage.metadata();
  const baseWidth = metadata.width ?? 1024;
  const baseHeight = metadata.height ?? 1024;
  const { x: offsetX, y: offsetY } = tileOffsetForJob(jobId);

  const extendedTile = await sharp(tileBuffer)
    .extend({
      top: offsetY,
      left: offsetX,
      bottom: Math.max(0, baseHeight - tileHeight) + tileHeight,
      right: Math.max(0, baseWidth - tileWidth) + tileWidth,
      extendWith: 'repeat',
    })
    .png()
    .toBuffer();
  const repeatedTile = await sharp(extendedTile)
    .extract({ left: 0, top: 0, width: baseWidth, height: baseHeight })
    .png()
    .toBuffer();

  return baseImage
    .composite([
      {
        input: repeatedTile,
        top: 0,
        left: 0,
        blend: 'over',
      },
    ])
    .png()
    .toBuffer();
}
