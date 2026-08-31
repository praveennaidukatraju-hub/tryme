import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Encodes which IPv4 ranges are blocked (loopback, private, link-local /
 * cloud-metadata, "this network", multicast/reserved). This is the single
 * source of truth for IPv4 range blocking — both the native `family === 4`
 * check and the IPv4-mapped-IPv6 (`::ffff:a.b.c.d`) check below must funnel
 * through this so an attacker can't bypass the blocklist by re-encoding a
 * blocked IPv4 address as its IPv6-mapped form.
 */
function isBlockedIpv4(parts: number[]): boolean {
  const a = parts[0];
  const b = parts[1];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast/reserved
  return false;
}

// IPv4-mapped IPv6 can reach us in two shapes:
//  - dotted-quad, e.g. "::ffff:169.254.169.254" (as returned by some DNS resolvers)
//  - hex-group, e.g. "::ffff:a9fe:a9fe" (WHATWG URL normalizes bracketed IPv6
//    literals like "[::ffff:169.254.169.254]" into THIS form before we ever see
//    `parsed.hostname` — the dotted form never reaches us for URL literals).
// Both must be unwrapped and checked, or the hex-group path is a silent bypass.
const IPV4_MAPPED_IPV6_DOTTED_RE = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_IPV6_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** Extracts the embedded IPv4 octets from an IPv4-mapped IPv6 address, in either
 * of its two textual shapes. Returns null if `normalized` isn't IPv4-mapped. */
function extractMappedIpv4Parts(normalized: string): number[] | null {
  const dotted = normalized.match(IPV4_MAPPED_IPV6_DOTTED_RE);
  if (dotted) {
    return [Number(dotted[1]), Number(dotted[2]), Number(dotted[3]), Number(dotted[4])];
  }
  const hex = normalized.match(IPV4_MAPPED_IPV6_HEX_RE);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

/**
 * Blocks loopback, private, link-local, and other non-public ranges. Applied to
 * the actually-resolved IP (not just the hostname string) so a hostname that
 * resolves to a private address is still blocked.
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    return isBlockedIpv4(parts);
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true; // loopback
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true; // link-local fe80::/10
    }
    if (normalized === '::') return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) — unwrap and re-check
    // against the same IPv4 blocklist, otherwise e.g. ::ffff:169.254.169.254
    // sails through as a "valid family-6 address" and never gets range-checked.
    const mappedParts = extractMappedIpv4Parts(normalized);
    if (mappedParts) return isBlockedIpv4(mappedParts);
    return false;
  }
  return true; // not a recognizable IP — treat as blocked
}

export interface PublicHttpTarget {
  url: URL;
  /** The specific address validated by this call, to be pinned on the actual
   *  connection later — resolving the hostname again at fetch time would let a
   *  DNS-rebinding attacker swap in a private address between check and use. */
  address: string;
}

/**
 * Validates a user-supplied URL is safe for the server to fetch: http(s) only,
 * and every DNS-resolved address for its hostname is a public address. Returns
 * the parsed URL plus the one address the caller must connect to — re-resolving
 * the hostname at fetch time reopens the DNS-rebinding TOCTOU this guard exists
 * to close.
 */
export async function assertPublicHttpUrl(input: string): Promise<PublicHttpTarget> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new AppError('VALIDATION', 400, 'not a valid URL');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new AppError('VALIDATION', 400, 'only http/https URLs are supported');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily !== 0
      ? [hostname]
      : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
  if (addresses.length === 0) {
    throw new AppError('VALIDATION', 400, 'could not resolve host');
  }
  if (addresses.some((ip) => isBlockedIp(ip))) {
    throw new AppError('VALIDATION', 400, 'this URL host is not allowed');
  }
  return { url: parsed, address: addresses[0] };
}
