import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/**
 * Connects directly to `address` (the IP validated by assertPublicHttpUrl)
 * instead of letting the HTTP client re-resolve `url.hostname` itself — that
 * second resolution is exactly what a DNS-rebinding attacker exploits. The
 * `Host` header and TLS `servername` still carry the original hostname so
 * virtual-hosted servers and certificate validation behave normally.
 *
 * Never follows redirects (matches the previous `redirect: 'manual'` fetch()
 * behavior) — callers re-validate each hop's Location via assertPublicHttpUrl.
 */
export function pinnedFetch(url: URL, address: string, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        hostname: address,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Host: url.hostname },
        servername: isHttps ? url.hostname : undefined,
        signal,
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: res.statusCode ?? 0, headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
