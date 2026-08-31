import { describe, expect, it } from 'vitest';
import { sniffImageMime } from '../src/modules/dev/image-sniff.js';

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const webp = () => {
  const b = Buffer.alloc(20);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(12, 4);
  b.write('WEBP', 8, 'ascii');
  return b;
};

describe('sniffImageMime', () => {
  it('detects jpeg', () => {
    expect(sniffImageMime(jpeg())).toBe('image/jpeg');
  });

  it('detects png', () => {
    expect(sniffImageMime(png())).toBe('image/png');
  });

  it('detects webp', () => {
    expect(sniffImageMime(webp())).toBe('image/webp');
  });

  it('rejects a non-image', () => {
    expect(sniffImageMime(Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'))).toBeUndefined();
  });

  it('rejects a RIFF container that is not WEBP (e.g. a wav)', () => {
    const b = Buffer.alloc(20);
    b.write('RIFF', 0, 'ascii');
    b.write('WAVE', 8, 'ascii');
    expect(sniffImageMime(b)).toBeUndefined();
  });

  it('rejects a buffer too short to hold a signature', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeUndefined();
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined();
  });

  it('rejects an SVG (an image type we do not allow — it can carry script)', () => {
    expect(
      sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'utf8')),
    ).toBeUndefined();
  });
});
