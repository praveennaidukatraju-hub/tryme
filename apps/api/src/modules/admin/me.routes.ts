import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getRolePermissions, requirePermission } from './guard.js';

const ThemePreference = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
});

export async function adminMeRoutes(app: FastifyInstance) {
  const GUARD = requirePermission('admin.me');

  app.get('/admin/me', { preHandler: GUARD }, async (req) => {
    const [user] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');

    const [adminUser] = await app.db
      .select({ preferences: schema.adminUsers.preferences })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, req.userId));

    const perms = await getRolePermissions(app, req.adminRole!);

    return {
      userId: req.userId,
      email: user.email,
      role: req.adminRole,
      permissions: Array.from(perms),
      preferences: adminUser?.preferences ?? {},
    };
  });

  app.patch(
    '/admin/me/preferences',
    {
      preHandler: GUARD,
      schema: { body: ThemePreference },
    },
    async (req) => {
      const { theme } = req.body as z.infer<typeof ThemePreference>;
      const preferences = theme ? { theme } : {};

      const [updated] = await app.db
        .update(schema.adminUsers)
        .set({ preferences })
        .where(eq(schema.adminUsers.userId, req.userId))
        .returning({ preferences: schema.adminUsers.preferences });

      return updated;
    },
  );
}
