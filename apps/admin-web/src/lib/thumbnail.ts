/**
 * Downscale an image File to a small JPEG thumbnail using a canvas.
 *
 * Grids/pickers render the `thumbnail_key` object — keeping it small (vs the full-res
 * main upload) is what makes the admin + studio grids load fast. The main image is
 * still uploaded full-res separately; only the thumb PUT should use this output.
 *
 * Falls back to returning the original file unchanged if it is not a raster image the
 * browser can decode, or if canvas encoding fails — the upload still succeeds, just
 * without shrinking.
 */
export async function makeThumbnail(file: File, max = 512, quality = 0.78): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    return blob ?? file;
  } catch {
    return file;
  }
}
