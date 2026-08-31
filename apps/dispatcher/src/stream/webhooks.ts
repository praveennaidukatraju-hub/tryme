import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { hostname } from 'node:os';
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

const GROUP = 'dispatcher-webhooks-cg';
const CONSUMER = hostname();

export async function runWebhooksConsumer(db: DB, redis: Redis, log: Logger): Promise<() => void> {
  let running = true;

  try {
    await redis.xgroup('CREATE', 'webhooks:outbound', GROUP, '$', 'MKSTREAM');
    log.info('webhooks consumer group created');
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }

  void (async function loop() {
    while (running) {
      try {
        const result = (await redis.xreadgroup(
          'GROUP',
          GROUP,
          CONSUMER,
          'COUNT',
          '1',
          'BLOCK',
          '2000',
          'STREAMS',
          'webhooks:outbound',
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!running) break;
        if (!result?.[0]?.[1].length) continue;

        const stream = result[0][0];
        const entry = result[0][1][0];
        if (!entry) continue;
        const [messageId, fields] = entry;

        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          const k = fields[i];
          const v = fields[i + 1];
          if (k !== undefined && v !== undefined) data[k] = v;
        }

        const jobId = data.jobId;
        const merchantId = data.merchantId;
        const attempt = parseInt(data.attempt || '1', 10);
        const notBefore = parseInt(data.notBefore || '0', 10);

        if (!merchantId) {
          await redis.xack(stream, GROUP, messageId);
          continue;
        }

        // Backoff: if this delivery is not yet due, re-enqueue unchanged and ack the
        // current entry. A short sleep prevents a hot loop when the stream only holds
        // not-yet-due retries.
        if (notBefore > Date.now()) {
          await redis.xadd(stream, 'MAXLEN', '~', 10000, '*', ...toFields(data));
          await redis.xack(stream, GROUP, messageId);
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        const [client] = await db
          .select({
            webhookUrl: schema.merchants.webhookUrl,
            webhookSecret: schema.merchants.webhookSecret,
          })
          .from(schema.merchants)
          .where(eq(schema.merchants.id, merchantId))
          .limit(1);

        if (!client?.webhookUrl) {
          await redis.xack(stream, GROUP, messageId);
          continue;
        }

        const isSafe = await isSafeUrl(client.webhookUrl);
        if (!isSafe) {
          log.warn({ merchantId, url: client.webhookUrl }, 'unsafe webhook URL rejected');
          await redis.xack(stream, GROUP, messageId);
          continue;
        }

        // Only the public event fields reach the merchant — internal routing fields
        // (attempt, notBefore) stay in the stream and are never signed or sent.
        const body: Record<string, string> = {
          jobId: jobId ?? '',
          merchantId,
          status: data.status ?? '',
        };
        if (data.resultKey) body.resultKey = data.resultKey;
        if (data.errorCode) body.errorCode = data.errorCode;
        const payload = JSON.stringify(body);

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Webhook-Timestamp': timestamp,
        };

        if (client.webhookSecret) {
          const sig = createHmac('sha256', client.webhookSecret)
            .update(`${timestamp}.${payload}`)
            .digest('hex');
          headers['X-Webhook-Signature'] = `t=${timestamp},v1=${sig}`;
        }

        let success = false;
        try {
          const res = await fetch(client.webhookUrl, {
            method: 'POST',
            headers,
            body: payload,
            redirect: 'error', // never follow redirects — a 3xx to an internal host would bypass isSafeUrl
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) success = true;
        } catch {
          // network error / timeout / redirect — handled below
        }

        if (success) {
          await redis.xack(stream, GROUP, messageId);
        } else {
          if (attempt < 3) {
            // Re-enqueue with incremented attempt counter and exponential backoff
            // (attempt 1 fail → +5s, attempt 2 fail → +10s) so a merchant that is
            // briefly down gets real recovery time instead of 3 instant retries.
            const delayMs = 5000 * 2 ** (attempt - 1);
            const next = {
              ...data,
              attempt: String(attempt + 1),
              notBefore: String(Date.now() + delayMs),
            };
            await redis.xadd(stream, 'MAXLEN', '~', 10000, '*', ...toFields(next));
          } else {
            log.warn({ jobId, merchantId }, 'webhook delivery failed after 3 attempts');
          }
          await redis.xack(stream, GROUP, messageId);
        }
      } catch (err) {
        log.error({ err }, 'webhooks consumer loop error');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  return () => {
    running = false;
  };
}

/** Serialize a stream-field map into the flat key/value array xadd expects. */
function toFields(data: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) out.push(k, String(v));
  return out;
}

function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and evaluate as IPv4 so a mapped
  // loopback/metadata address (e.g. ::ffff:169.254.169.254) can't slip through.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return isPrivateIp(mapped[1]);

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (covers fd00::)
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // malformed → treat as unsafe
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// SSRF guard. Enforces https, then resolves the hostname and rejects any answer in a
// private/loopback/link-local/metadata range. NOTE: there is a residual TOCTOU window —
// fetch() re-resolves DNS independently, so a low-TTL rebind between this check and the
// request could still land on a private IP. Closing it fully requires pinning the
// resolved IP for the connection (not supported by Node's fetch); redirect:'error' on the
// fetch removes the easier redirect-based bypass.
async function isSafeUrl(urlStr: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;

  const rawHostname = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (net.isIP(rawHostname)) {
    return !isPrivateIp(rawHostname);
  }

  try {
    const records4 = await dns.resolve4(rawHostname).catch(() => []);
    const records6 = await dns.resolve6(rawHostname).catch(() => []);
    const allRecords = [...records4, ...records6];
    if (allRecords.length === 0) return false;
    for (const ip of allRecords) {
      if (isPrivateIp(ip)) return false;
    }
  } catch {
    return false;
  }
  return true;
}
