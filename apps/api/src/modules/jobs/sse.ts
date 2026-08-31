import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

// reply.raw.writeHead() bypasses Fastify's reply pipeline entirely, so headers set by
// plugins via reply.header() (e.g. @fastify/cors's Access-Control-Allow-Origin) never
// reach the actual response — the browser then blocks the request as a CORS failure
// even though the server responded 200. CORS headers must be set explicitly here.
function writeSseHeaders(req: FastifyRequest, reply: FastifyReply): void {
  const corsOrigin = (req.server as FastifyInstance).env?.CORS_ORIGIN;
  const reqOrigin = req.headers.origin;
  const allowOrigin =
    reqOrigin && Array.isArray(corsOrigin) && corsOrigin.includes(reqOrigin) ? reqOrigin : null;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(allowOrigin
      ? { 'Access-Control-Allow-Origin': allowOrigin, 'Access-Control-Allow-Credentials': 'true' }
      : {}),
  });
}

function makeSubscription(
  req: FastifyRequest,
  reply: FastifyReply,
  channel: string,
  filter?: (evt: Record<string, unknown>) => boolean,
): void {
  const sub: Redis = (req.server as FastifyInstance).redisSub.duplicate();

  // ioredis throws an uncaught exception (crashing the process) if a connection
  // emits 'error' with no listener attached — must register one even if a no-op.
  sub.on('error', (err) => {
    (req.log ?? console).warn?.({ err, channel }, 'sse redis subscriber error');
  });

  sub.subscribe(channel).then(() => {
    sub.on('message', (_ch, raw) => {
      try {
        const evt = JSON.parse(raw) as Record<string, unknown>;
        if (filter && !filter(evt)) return;
        reply.raw.write(`event: ${evt.type ?? 'message'}\ndata: ${raw}\n\n`);
      } catch {
        /* ignore malformed publish */
      }
    });
  });

  const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 15_000);

  req.raw.on('close', async () => {
    clearInterval(heartbeat);
    try {
      await sub.unsubscribe(channel);
    } catch {
      /* connection may already be closed */
    }
    sub.disconnect();
  });
}

/** Per-job SSE — kept for backward compatibility. */
export async function sseHandler(this: unknown, req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { userId } = req;
  writeSseHeaders(req, reply);
  makeSubscription(req, reply, `sse:events:${userId}`, (evt) => evt.jobId === id);
}

/** User-level stream — all job events for the authenticated user, no jobId filter. */
export async function userStreamHandler(this: unknown, req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req;
  writeSseHeaders(req, reply);
  makeSubscription(req, reply, `sse:events:${userId}`);
}

/** Admin-level stream — all job events across all users. */
export async function adminStreamHandler(this: unknown, req: FastifyRequest, reply: FastifyReply) {
  writeSseHeaders(req, reply);
  makeSubscription(req, reply, 'sse:events:admin');
}
