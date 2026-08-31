import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminRole?: string;
  }
}

export type AdminRole = 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT' | 'ADMIN';

export async function resolveAdminAccess(
  app: FastifyInstance,
  userId: string,
): Promise<{ role: string; status: string } | null> {
  const [a] = await app.db
    .select({ role: schema.adminUsers.role, status: schema.adminUsers.status })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.userId, userId));
  if (!a) return null;
  return { role: a.role, status: a.status };
}

export async function getRolePermissions(app: FastifyInstance, role: string): Promise<Set<string>> {
  const rows = await app.db
    .select({ key: schema.permissions.key })
    .from(schema.rolePermissions)
    .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
    .where(eq(schema.rolePermissions.role, role));
  return new Set(rows.map((r) => r.key));
}

export function requirePermission(permission: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const app = req.server as FastifyInstance;
    await app.requireAdminUser(req, reply);
    const admin = await resolveAdminAccess(app, req.userId);
    if (!admin) throw new AppError('FORBIDDEN', 403, 'admin required');
    if (admin.status !== 'active') throw new AppError('FORBIDDEN', 403, 'admin account not active');
    req.adminRole = admin.role;

    const perms = await getRolePermissions(app, admin.role);
    if (!perms.has(permission)) {
      throw new AppError('FORBIDDEN', 403, 'insufficient permissions');
    }
  };
}

export function requireAnyPermission(permissions: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const app = req.server as FastifyInstance;
    await app.requireAdminUser(req, reply);
    const admin = await resolveAdminAccess(app, req.userId);
    if (!admin) throw new AppError('FORBIDDEN', 403, 'admin required');
    if (admin.status !== 'active') throw new AppError('FORBIDDEN', 403, 'admin account not active');
    req.adminRole = admin.role;

    const perms = await getRolePermissions(app, admin.role);
    const hasAny = permissions.some((p) => perms.has(p));
    if (!hasAny) {
      throw new AppError('FORBIDDEN', 403, 'insufficient permissions');
    }
  };
}

export function requireAdmin(roles: AdminRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const app = req.server as FastifyInstance;
    await app.requireAdminUser(req, reply);
    const admin = await resolveAdminAccess(app, req.userId);
    if (!admin) throw new AppError('FORBIDDEN', 403, 'admin required');
    if (admin.status !== 'active') throw new AppError('FORBIDDEN', 403, 'admin account not active');
    if (!roles.includes(admin.role as AdminRole))
      throw new AppError('FORBIDDEN', 403, 'insufficient admin role');
    req.adminRole = admin.role;
  };
}
