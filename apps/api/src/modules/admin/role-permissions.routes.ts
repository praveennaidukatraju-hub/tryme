import { schema } from '@tryme/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';

// SUPER_ADMIN is deliberately excluded from every route here. Its access is 52 real
// role_permissions rows (see migration 0160_permissions.sql), not a code bypass —
// guard.ts's getRolePermissions() looks SUPER_ADMIN up like any other role — so
// letting this endpoint edit it risks a Super Admin locking every admin (including
// themselves) out of the whole admin panel with one accidental unchecked box. The
// zod enum below is the actual enforcement; there is no separate runtime check to
// forget.
const EDITABLE_ROLES = ['ADMIN', 'MODERATOR', 'SUPPORT'] as const;
const ALL_ROLES = ['SUPER_ADMIN', ...EDITABLE_ROLES] as const;

const PatchBody = z.object({
  role: z.enum(EDITABLE_ROLES),
  permissionKey: z.string().min(1),
  granted: z.boolean(),
});

export async function adminRolePermissionsRoutes(app: FastifyInstance) {
  const GUARD = requirePermission('admin_users.manage');

  app.get('/admin/role-permissions', { preHandler: GUARD }, async () => {
    const allPermissions = await app.db
      .select({
        id: schema.permissions.id,
        key: schema.permissions.key,
        description: schema.permissions.description,
      })
      .from(schema.permissions)
      .orderBy(asc(schema.permissions.key));

    const grants = await app.db
      .select({
        role: schema.rolePermissions.role,
        permissionId: schema.rolePermissions.permissionId,
      })
      .from(schema.rolePermissions);

    const keyById = new Map(allPermissions.map((p) => [p.id, p.key]));
    const matrix: Record<string, string[]> = {
      SUPER_ADMIN: [],
      ADMIN: [],
      MODERATOR: [],
      SUPPORT: [],
    };
    for (const g of grants) {
      const key = keyById.get(g.permissionId);
      if (key && g.role in matrix) matrix[g.role].push(key);
    }

    return {
      roles: ALL_ROLES,
      editableRoles: EDITABLE_ROLES,
      permissions: allPermissions,
      matrix,
    };
  });

  app.patch(
    '/admin/role-permissions',
    { preHandler: GUARD, schema: { body: PatchBody } },
    async (req) => {
      const { role, permissionKey, granted } = req.body as z.infer<typeof PatchBody>;

      const [permission] = await app.db
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, permissionKey));
      if (!permission) throw new AppError('NOT_FOUND', 404, 'unknown permission key');

      await app.db.transaction(async (tx) => {
        if (granted) {
          await tx
            .insert(schema.rolePermissions)
            .values({ role, permissionId: permission.id })
            .onConflictDoNothing();
        } else {
          await tx
            .delete(schema.rolePermissions)
            .where(
              and(
                eq(schema.rolePermissions.role, role),
                eq(schema.rolePermissions.permissionId, permission.id),
              ),
            );
        }

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole ?? '' },
          action: granted ? 'role_permissions.grant' : 'role_permissions.revoke',
          resourceType: 'role_permissions',
          resourceId: role,
          after: { role, permissionKey, granted },
          request: req,
        });
      });

      return { ok: true, role, permissionKey, granted };
    },
  );
}
