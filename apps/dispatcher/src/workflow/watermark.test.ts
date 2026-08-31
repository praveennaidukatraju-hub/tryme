import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applyWatermark, initWatermarkTile, tileOffsetForJob } from './watermark.js';

async function makeTestImage(
  width: number,
  height: number,
  background: { r: number; g: number; b: number } = { r: 200, g: 200, b: 200 },
): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 3, background },
  })
    .png()
    .toBuffer();
}

describe('WatermarkService', () => {
  beforeAll(async () => {
    await initWatermarkTile();
  });

  it('applies a composite without throwing, output is a valid, larger-than-trivial PNG', async () => {
    const image = await makeTestImage(800, 1200);
    const result = await applyWatermark({ image, jobId: 'job-a' });
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1200);
    expect(meta.format).toBe('png');
  });

  it('keeps watermark intensity subtle instead of veiling the full image', async () => {
    const image = await makeTestImage(800, 1200, { r: 0, g: 0, b: 0 });
    const result = await applyWatermark({ image, jobId: 'subtle-check' });
    const stats = await sharp(result).stats();
    const channelMeans = stats.channels.slice(0, 3).map((channel) => channel.mean);
    const averageMean = channelMeans.reduce((sum, value) => sum + value, 0) / channelMeans.length;

    expect(averageMean).toBeGreaterThan(0.05);
    expect(averageMean).toBeLessThan(2);
  });

  it('is deterministic for the same jobId', async () => {
    const image = await makeTestImage(600, 600);
    const a = await applyWatermark({ image, jobId: 'same-job' });
    const b = await applyWatermark({ image, jobId: 'same-job' });
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('produces a different composite for different jobIds (jobId-seeded offset)', async () => {
    const image = await makeTestImage(600, 600);
    const a = await applyWatermark({ image, jobId: 'job-one' });
    const b = await applyWatermark({ image, jobId: 'job-two' });
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('tileOffsetForJob returns a stable offset within tile bounds for a given jobId', () => {
    const offset1 = tileOffsetForJob('deterministic-job');
    const offset2 = tileOffsetForJob('deterministic-job');
    expect(offset1).toEqual(offset2);
    expect(offset1.x).toBeGreaterThanOrEqual(0);
    expect(offset1.y).toBeGreaterThanOrEqual(0);
  });

  it('rejects with a clear error if applyWatermark is called before initWatermarkTile', async () => {
    vi.resetModules();
    const fresh = await import('./watermark.js');
    const image = await makeTestImage(400, 400);
    await expect(fresh.applyWatermark({ image, jobId: 'job-init-check' })).rejects.toThrow(
      'WatermarkService not initialized',
    );
  });
});
