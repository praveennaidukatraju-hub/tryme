import { schema } from '@tryme/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { hashRefresh, newRefreshToken, signAccess, verifyPassword } from '../auth/service.js';
import { createAdminSessionTokens, parseDuration } from '../auth/tokens.js';

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post(
    '/admin/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = req.body as { email: string; password: string };
      if (!email || !password) throw new AppError('INVALID', 400, 'email and password required');

      const [user] = await app.db
        .select({ id: schema.users.id, emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      if (!user?.emailVerified) throw new AppError('INVALID', 401, 'invalid credentials');

      const [admin] = await app.db
        .select({ passwordHash: schema.adminUsers.passwordHash, status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, user.id));
      if (admin?.status !== 'active') throw new AppError('INVALID', 401, 'invalid credentials');
      if (!admin.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!(await verifyPassword(admin.passwordHash, password)))
        throw new AppError('INVALID', 401, 'invalid credentials');

      return createAdminSessionTokens(app, user.id, reply, 200);
    },
  );

  app.post('/admin/auth/refresh', async (req, reply) => {
    const plain = req.cookies.refresh;
    if (!plain) throw new AppError('NO_REFRESH', 401, 'no refresh token');
    const tokenHash = hashRefresh(plain);

    const result = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .for('update');

      if (!row || row.expiresAt < new Date() || row.revokedAt) return { kind: 'invalid' } as const;
      if (row.portal !== 'admin') return { kind: 'invalid' } as const;
      if (!row.userId) return { kind: 'invalid' } as const;

      if (row.usedAt) {
        const ageMs = Date.now() - row.usedAt.getTime();
        const [successor] = await tx
          .select({ userId: schema.refreshTokens.userId })
          .from(schema.refreshTokens)
          .where(
            and(
              eq(schema.refreshTokens.familyId, row.familyId),
              isNull(schema.refreshTokens.usedAt),
              isNull(schema.refreshTokens.revokedAt),
            ),
          )
          .orderBy(desc(schema.refreshTokens.generation))
          .limit(1);
        if (successor?.userId) {
          app.log.info(
            { familyId: row.familyId, generation: row.generation, ageMs },
            'admin concurrent refresh: reissuing from active successor',
          );
          return { kind: 'reissue', userId: successor.userId } as const;
        }
        return { kind: 'invalid' } as const;
      }

      await tx
        .update(schema.refreshTokens)
        .set({ usedAt: new Date() })
        .where(eq(schema.refreshTokens.id, row.id));

      const r = newRefreshToken();
      const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
      await tx.insert(schema.refreshTokens).values({
        userId: row.userId,
        familyId: row.familyId,
        generation: row.generation + 1,
        tokenHash: r.hash,
        expiresAt,
        portal: 'admin',
      });

      return {
        kind: 'rotated',
        userId: row.userId,
        refreshPlain: r.plain,
        expiresAt,
      } as const;
    });

    const secret = new TextEncoder().encode(app.env.JWT_SECRET);

    switch (result.kind) {
      case 'invalid':
        throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');

      case 'reissue':
        return {
          accessToken: await signAccess(
            secret,
            result.userId,
            { kind: 'access' },
            app.env.JWT_EXPIRY,
            'admin',
          ),
        };

      case 'rotated':
        reply.setCookie('refresh', result.refreshPlain, {
          httpOnly: true,
          secure: app.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/admin/auth',
          expires: result.expiresAt,
          signed: false,
        });
        reply.code(200);
        return {
          accessToken: await signAccess(
            secret,
            result.userId,
            { kind: 'access' },
            app.env.JWT_EXPIRY,
            'admin',
          ),
        };
    }
  });

  app.post('/admin/auth/logout', async (req) => {
    const plain = req.cookies.refresh;
    if (plain) {
      const tokenHash = hashRefresh(plain);
      const [row] = await app.db
        .select({ familyId: schema.refreshTokens.familyId, portal: schema.refreshTokens.portal })
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .limit(1);
      if (row?.portal === 'admin') {
        await app.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, row.familyId));
      }
    }
    return { ok: true };
  });
}
