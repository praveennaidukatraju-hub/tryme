import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
import type { Principal } from '../routes/conversations.js';
import { verifyBearer } from '../routes/conversations.js';

const TTL_SECONDS = 30;

export async function ticketRoutes(app: FastifyInstance) {
  app.post('/ws-ticket', async (req) => {
    const principal = await verifyBearer(app, req.headers.authorization);
    const ticket = randomBytes(24).toString('base64url');
    await app.deps.redis.set(
      `chatbot:ws:ticket:${ticket}`,
      JSON.stringify(principal),
      'EX',
      TTL_SECONDS,
    );
    return { ticket };
  });
}

export async function redeemTicket(app: FastifyInstance, ticket: string): Promise<Principal> {
  const raw = await app.deps.redis.getdel(`chatbot:ws:ticket:${ticket}`);
  if (!raw) throw new AppError('UNAUTH', 401, 'invalid or expired ticket');
  return JSON.parse(raw) as Principal;
}
