import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl } from './ssrf-guard.js';

describe('assertPublicHttpUrl', () => {
  it('accepts a public IP literal', async () => {
    const target = await assertPublicHttpUrl('http://1.1.1.1/image.jpg');
    expect(target.url.hostname).toBe('1.1.1.1');
    expect(target.address).toBe('1.1.1.1');
  });

  it('rejects loopback', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects private 10.x', async () => {
    await expect(assertPublicHttpUrl('http://10.0.0.5/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects private 192.168.x', async () => {
    await expect(assertPublicHttpUrl('http://192.168.1.1/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects private 172.16-31.x', async () => {
    await expect(assertPublicHttpUrl('http://172.20.0.5/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects link-local / cloud metadata address', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/x.jpg')).rejects.toThrow(
      /not allowed/,
    );
  });

  it('rejects IPv6 loopback', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com/x.jpg')).rejects.toThrow(
      /only http\/https/,
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/not a valid URL/);
  });

  it('rejects an IPv4-mapped IPv6 address for a blocked range other than loopback', async () => {
    await expect(assertPublicHttpUrl('http://[::ffff:169.254.169.254]/x.jpg')).rejects.toThrow(
      /not allowed/,
    );
  });

  it('rejects an IPv4-mapped IPv6 address for private 10.x', async () => {
    await expect(assertPublicHttpUrl('http://[::ffff:10.0.0.5]/x.jpg')).rejects.toThrow(
      /not allowed/,
    );
  });

  it('accepts an IPv4-mapped IPv6 address for a public IP', async () => {
    // WHATWG URL normalizes bracketed IPv4-mapped IPv6 literals to hex-group
    // form (e.g. "::ffff:1.1.1.1" -> "::ffff:101:101") before we ever see
    // `parsed.hostname`, so assert against the normalized form.
    const target = await assertPublicHttpUrl('http://[::ffff:1.1.1.1]/x.jpg');
    expect(target.url.hostname).toBe('[::ffff:101:101]');
  });
});
