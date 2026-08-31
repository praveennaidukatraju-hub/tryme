import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { verifyAccess } from '../modules/auth/service.js';

export const portalAuthPlugin = fp(async (app) => {
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);

  // Authorizes off the same access token the catalogues-web user session uses
  // (aud-less, kind:'access', sub = users.id) — a merchant is a user with a
  // merchants profile attached, so there is no separate merchant login/token.
  app.decorate('requireMerchant', async (req, _reply) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!token) throw new AppError('UNAUTH', 401, 'missing bearer');

    let userId: string;
    try {
      const payload = await verifyAccess(secret, token);
      if ((payload as Record<string, unknown>).kind !== 'access') {
        throw new AppError('UNAUTH', 401, 'invalid token');
      }
      userId = String(payload.sub);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UNAUTH', 401, 'invalid token');
    }

    const [client] = await app.db
      .select({ id: schema.merchants.id, isActive: schema.merchants.isActive })
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId))
      .limit(1);
    if (!client) throw new AppError('FORBIDDEN', 403, 'not a merchant account');
    if (!client.isActive) throw new AppError('FORBIDDEN', 403, 'merchant account inactive');

    req.merchantClientId = client.id;
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    merchantClientId?: string;
  }
  interface FastifyInstance {
    requireMerchant: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
