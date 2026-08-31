export type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detects image type from magic bytes. Returns undefined for anything that is
 * not one of the three allowed types.
 *
 * The client-declared Content-Type is attacker-controlled and is never consulted:
 * this reads what the bytes actually are. SVG is intentionally absent — it is
 * XML that can carry script, and ComfyUI cannot consume it anyway.
 */
export function sniffImageMime(buf: Buffer): AllowedImageMime | undefined {
  if (buf.length < 12) return undefined;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}
