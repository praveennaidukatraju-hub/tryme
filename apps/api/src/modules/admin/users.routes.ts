import { schema } from '@tryme/db';
import {
  BulkDeleteUsersBody,
  CreateUserBody,
  ResetPasswordBody,
  UpdateUserBody,
} from '@tryme/types';
import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { hashPassword } from '../auth/service.js';
import { disconnect as disconnectGoogleDrive } from '../google-drive/token.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';
import { jobTypeSql } from './job-type.js';
import { renderUsersExportPdf } from './users-export-pdf.js';
import { loadUsersForExport, UsersExportQuery } from './users-export-query.js';
import { renderUsersExportXlsx } from './users-export-xlsx.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const PaginatedSearch = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  merchant: z.coerce.boolean().optional(),
  showBanned: z.coerce.boolean().optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  tier: z.string().optional(),
});

export async function adminUsersRoutes(app: FastifyInstance) {
  const ALL = requirePermission('users.read');
  const WRITE = requirePermission('users.write');

  app.get(
    '/admin/users',
    { preHandler: ALL, schema: { querystring: PaginatedSearch } },
    async (req) => {
      const { page, pageSize, search, merchant, showBanned, createdFrom, createdTo, tier } =
        req.query as z.infer<typeof PaginatedSearch>;

      const searchWhere = search
        ? or(
            ilike(schema.users.email, `%${search}%`),
            ilike(schema.users.displayName, `%${search}%`),
            ilike(schema.users.username, `%${search}%`),
          )
        : undefined;
      const bannedWhere = showBanned === true ? undefined : eq(schema.users.isBanned, false);
      const toInclusive = createdTo
        ? new Date(DATE_ONLY.test(createdTo) ? `${createdTo}T23:59:59.999Z` : createdTo)
        : undefined;
      const fromInclusive = createdFrom
        ? new Date(DATE_ONLY.test(createdFrom) ? `${createdFrom}T00:00:00.000Z` : createdFrom)
        : undefined;
      const where = and(
        searchWhere,
        bannedWhere,
        merchant === true ? isNotNull(schema.merchants.id) : undefined,
        fromInclusive ? gte(schema.users.createdAt, fromInclusive) : undefined,
        toInclusive ? lte(schema.users.createdAt, toInclusive) : undefined,
        tier ? eq(schema.users.tier, tier) : undefined,
      );

      const [{ total }] = await app.db
        .select({ total: count() })
        .from(schema.users)
        .leftJoin(schema.merchants, eq(schema.merchants.userId, schema.users.id))
        .where(where);

      const rows = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          username: schema.users.username,
          displayName: schema.users.displayName,
          phone: schema.users.phone,
          tier: schema.users.tier,
          maxActiveDevices: schema.users.maxActiveDevices,
          isBanned: schema.users.isBanned,
          banReason: schema.users.banReason,
          createdAt: schema.users.createdAt,
          updatedAt: schema.users.updatedAt,
          balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
          totalJobs: sql<number>`COUNT(${schema.jobs.id})::int`,
          lastJobAt: sql<string | null>`MAX(${schema.jobs.createdAt})`,
          isAdmin: isNotNull(schema.adminUsers.id),
          adminRole: schema.adminUsers.role,
          hasPassword: isNotNull(schema.users.passwordHash),
          hasShopifyStore: exists(
            app.db
              .select()
              .from(schema.shopifyStores)
              .where(
                and(
                  eq(schema.shopifyStores.ownerUserId, schema.users.id),
                  isNull(schema.shopifyStores.uninstalledAt),
                ),
              ),
          ),
          isMerchant: isNotNull(schema.merchants.id),
          signupSource: schema.merchants.signupSource,
          demoData: schema.merchants.demoData,
        })
        .from(schema.users)
        .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.users.id))
        .leftJoin(schema.jobs, eq(schema.jobs.userId, schema.users.id))
        .leftJoin(schema.adminUsers, eq(schema.adminUsers.userId, schema.users.id))
        .leftJoin(schema.merchants, eq(schema.merchants.userId, schema.users.id))
        .where(where)
        .groupBy(
          schema.users.id,
          schema.userCredits.balance,
          schema.adminUsers.id,
          schema.merchants.id,
        )
        .orderBy(desc(schema.users.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return { page, pageSize, total, items: rows };
    },
  );

  // Full (unpaginated) filtered export for the business-development/customer-
  // management team — name, contact, plan, and account fields, as either a
  // landscape PDF table or an .xlsx workbook. Shares the same search/merchant/
  // showBanned filters as the list above, plus a createdAt date range and sort
  // direction; loadUsersForExport applies the filters and row shape identically
  // for both formats.
  app.get(
    '/admin/users/export.pdf',
    { preHandler: ALL, schema: { querystring: UsersExportQuery } },
    async (req, reply) => {
      const query = req.query as UsersExportQuery;
      const rows = await loadUsersForExport(app, query);
      const pdf = await renderUsersExportPdf(rows, {
        generatedAt: new Date(),
        filters: {
          search: query.search,
          merchantsOnly: query.merchant,
          showBanned: query.showBanned,
          createdFrom: query.createdFrom,
          createdTo: query.createdTo,
          tier: query.tier,
          sortDir: query.sortDir,
        },
      });

      const filename = `users-export-${new Date().toISOString().slice(0, 10)}.pdf`;
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(pdf);
    },
  );

  app.get(
    '/admin/users/export.xlsx',
    { preHandler: ALL, schema: { querystring: UsersExportQuery } },
    async (req, reply) => {
      const query = req.query as UsersExportQuery;
      const rows = await loadUsersForExport(app, query);
      const xlsx = await renderUsersExportXlsx(rows, {
        generatedAt: new Date(),
        filters: {
          search: query.search,
          merchantsOnly: query.merchant,
          showBanned: query.showBanned,
          createdFrom: query.createdFrom,
          createdTo: query.createdTo,
          tier: query.tier,
          sortDir: query.sortDir,
        },
      });

      const filename = `users-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(xlsx);
    },
  );

  app.get(
    '/admin/users/:id',
    {
      preHandler: ALL,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [user] = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          username: schema.users.username,
          displayName: schema.users.displayName,
          phone: schema.users.phone,
          tier: schema.users.tier,
          maxActiveDevices: schema.users.maxActiveDevices,
          isBanned: schema.users.isBanned,
          banReason: schema.users.banReason,
          createdAt: schema.users.createdAt,
          updatedAt: schema.users.updatedAt,
          isAdmin: isNotNull(schema.adminUsers.id),
          adminRole: schema.adminUsers.role,
          hasPassword: isNotNull(schema.users.passwordHash),
          hasShopifyStore: exists(
            app.db
              .select()
              .from(schema.shopifyStores)
              .where(
                and(
                  eq(schema.shopifyStores.ownerUserId, schema.users.id),
                  isNull(schema.shopifyStores.uninstalledAt),
                ),
              ),
          ),
        })
        .from(schema.users)
        .leftJoin(schema.adminUsers, eq(schema.adminUsers.userId, schema.users.id))
        .where(eq(schema.users.id, id));
      const [credits] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, id));
      const [merchantRow] = await app.db
        .select({
          id: schema.merchants.id,
          companyName: schema.merchants.companyName,
          contactName: schema.merchants.contactName,
          phone: schema.merchants.phone,
          businessAddress: schema.merchants.businessAddress,
          isActive: schema.merchants.isActive,
          demoData: schema.merchants.demoData,
          jobRateLimitPerMin: schema.merchants.jobRateLimitPerMin,
          logoKey: schema.merchants.logoKey,
        })
        .from(schema.merchants)
        .where(eq(schema.merchants.userId, id));
      const [[jobsCount], jobs] = await Promise.all([
        app.db.select({ total: count() }).from(schema.jobs).where(eq(schema.jobs.userId, id)),
        app.db
          .select({
            id: schema.jobs.id,
            status: schema.jobs.status,
            createdAt: schema.jobs.createdAt,
            startedAt: schema.jobs.startedAt,
            completedAt: schema.jobs.completedAt,
            creditsCharged: schema.jobs.creditsCharged,
            jobType: jobTypeSql(),
          })
          .from(schema.jobs)
          .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
          .where(eq(schema.jobs.userId, id))
          .orderBy(desc(schema.jobs.createdAt))
          .limit(5),
      ]);
      return {
        ...user,
        balance: credits?.balance ?? 0,
        totalJobs: jobsCount?.total ?? 0,
        recentJobs: jobs,
        merchant: merchantRow
          ? {
              ...merchantRow,
              // No manual cache-bust needed: presignGet() embeds a fresh X-Amz-Date/
              // X-Amz-Signature on every call, so the URL (and thus any URL-keyed cache)
              // already changes on every re-fetch. Appending an extra query param here
              // previously broke SigV4 validation (403 SignatureDoesNotMatch) — the
              // signature only covers the exact query string present when it was signed.
              logoUrl: merchantRow.logoKey
                ? (await app.storage.presignGet(merchantRow.logoKey, 3600)).url
                : null,
            }
          : null,
      };
    },
  );

  app.patch(
    '/admin/users/:id',
    {
      preHandler: WRITE,
      schema: { params: z.object({ id: z.string().uuid() }), body: UpdateUserBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { tier, maxActiveDevices, isBanned, banReason, forceLogout } = req.body as z.infer<
        typeof UpdateUserBody
      >;

      if (tier !== undefined) {
        const [plan] = await app.db
          .select({ slug: schema.creditPlans.slug })
          .from(schema.creditPlans)
          .where(and(eq(schema.creditPlans.slug, tier), eq(schema.creditPlans.isActive, true)));
        if (!plan)
          throw new AppError('BAD_REQUEST', 400, 'tier must be an active credit plan slug');
      }

      if (isBanned) {
        const [adminRow] = await app.db
          .select({ id: schema.adminUsers.id })
          .from(schema.adminUsers)
          .where(eq(schema.adminUsers.userId, id));
        if (adminRow) throw new AppError('FORBIDDEN', 403, 'cannot suspend an admin user');
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (tier !== undefined) patch.tier = tier;
      if (maxActiveDevices !== undefined) patch.maxActiveDevices = maxActiveDevices;
      if (isBanned !== undefined) patch.isBanned = isBanned;
      if (banReason !== undefined) patch.banReason = banReason;

      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, id))
          .for('update');
        if (!existing) throw new AppError('NOT_FOUND', 404, 'user not found');

        await tx.update(schema.users).set(patch).where(eq(schema.users.id, id));

        if (forceLogout) {
          await tx
            .update(schema.refreshTokens)
            .set({ revokedAt: new Date() })
            .where(eq(schema.refreshTokens.userId, id));
        }

        const { passwordHash: _beforeHash, ...beforeSafe } = existing;
        const { passwordHash: _afterHash, ...afterSafe } = { ...existing, ...patch };
        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: isBanned ? 'users.ban' : 'users.update',
          resourceType: 'user',
          resourceId: id,
          before: beforeSafe,
          after: afterSafe,
          request: req,
        });
      });

      return { ok: true };
    },
  );
  app.post(
    '/admin/users',
    { preHandler: WRITE, schema: { body: CreateUserBody } },
    async (req, reply) => {
      const { username, password, displayName, email, phone, companyName } = req.body as z.infer<
        typeof CreateUserBody
      >;
      const normalizedUsername = username.toLowerCase();

      const user = await app.db.transaction(async (tx) => {
        const [usernameConflict] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, normalizedUsername))
          .limit(1);
        if (usernameConflict) throw new AppError('USERNAME_TAKEN', 409, 'username already taken');

        if (email) {
          const [emailConflict] = await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, email))
            .limit(1);
          if (emailConflict) throw new AppError('EMAIL_TAKEN', 409, 'email already registered');
        }

        if (phone) {
          const [phoneConflict] = await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.phone, phone))
            .limit(1);
          if (phoneConflict) {
            throw new AppError('PHONE_TAKEN', 409, 'phone already assigned to another account');
          }
        }

        const passwordHash = await hashPassword(password);
        const [created] = await tx
          .insert(schema.users)
          .values({
            username: normalizedUsername,
            passwordHash,
            displayName,
            email: email ?? null,
            phone: phone ?? null,
            companyName: companyName ?? null,
            tier: 'free',
            emailVerified: true,
          })
          .returning({ id: schema.users.id });
        if (!created) throw new AppError('INTERNAL', 500, 'failed to create user');
        await tx.insert(schema.userCredits).values({ userId: created.id, balance: 0 });

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'users.create',
          resourceType: 'user',
          resourceId: created.id,
          after: { id: created.id, username: normalizedUsername, displayName, email },
          request: req,
        });

        return created;
      });

      reply.code(201);
      return { ok: true, userId: user.id };
    },
  );

  app.post(
    '/admin/users/:id/reset-password',
    {
      preHandler: WRITE,
      schema: { params: z.object({ id: z.string().uuid() }), body: ResetPasswordBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { newPassword } = req.body as z.infer<typeof ResetPasswordBody>;
      const passwordHash = await hashPassword(newPassword);
      await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.users)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(schema.users.id, id))
          .returning({ id: schema.users.id });
        if (!updated) throw new AppError('NOT_FOUND', 404, 'user not found');
        await tx
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.userId, id));

        // Never persist passwordHash itself into audit_logs.
        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'users.reset_password',
          resourceType: 'user',
          resourceId: id,
          request: req,
        });
      });
      return { ok: true };
    },
  );

  async function eraseUser(
    id: string,
    adminUserId?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [adminRow] = await app.db
      .select({ id: schema.adminUsers.id })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, id));
    if (adminRow) return { ok: false, reason: 'cannot delete an admin user' };

    const [merchantRow] = await app.db
      .select({ id: schema.merchants.id })
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, id));
    if (merchantRow) return { ok: false, reason: 'cannot erase a merchant account owner' };

    // Revoke before delete: dropping the row is not the same as revoking
    // authorization at Google. Runs against app.db directly (not tx) since
    // it's an external HTTP call — deliberately outside the transaction so
    // a Google outage can't roll back the erasure of PII we're obligated
    // to remove regardless. disconnect() clears the row itself.
    await disconnectGoogleDrive(app, id);

    await app.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .for('update');
      if (!existing) return;

      await tx
        .update(schema.users)
        .set({
          email: sql`'deleted+' || ${id} || '@example.invalid'`,
          displayName: 'Deleted User',
          phone: null,
          companyName: null,
          username: null,
          isBanned: true,
          banReason: 'admin erasure (GDPR)',
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, id));

      await tx.delete(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, id));

      await tx
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.userId, id));

      if (adminUserId) {
        await recordAudit(tx, {
          actor: { userId: adminUserId, role: 'SUPER_ADMIN' },
          action: 'users.delete',
          resourceType: 'user',
          resourceId: id,
          before: { id: existing.id, username: existing.username, email: existing.email },
        });
      }
    });

    app.log.warn(
      { adminUserId, targetUserId: id, action: 'USER_ERASURE' },
      'admin erased user PII',
    );

    return { ok: true };
  }

  app.delete(
    '/admin/users/:id',
    {
      preHandler: requirePermission('users.delete'),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const res = await eraseUser(id, req.userId);
      if (!res.ok) throw new AppError('FORBIDDEN', 403, res.reason);
      return { ok: true };
    },
  );

  app.post(
    '/admin/users/bulk-delete',
    {
      preHandler: requirePermission('users.delete'),
      schema: { body: BulkDeleteUsersBody },
    },
    async (req) => {
      const { ids } = req.body as z.infer<typeof BulkDeleteUsersBody>;
      const succeeded: string[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const id of ids) {
        const res = await eraseUser(id, req.userId);
        if (res.ok) {
          succeeded.push(id);
        } else {
          skipped.push({ id, reason: res.reason });
        }
      }

      return { succeeded, skipped };
    },
  );

  // Admin request management (SUPER_ADMIN only)
  const SUPER = requirePermission('admin_users.manage');

  app.get('/admin/admin-requests', { preHandler: SUPER }, async () => {
    const rows = await app.db
      .select({
        userId: schema.adminUsers.userId,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.adminUsers.role,
        requestedAt: schema.adminUsers.createdAt,
      })
      .from(schema.adminUsers)
      .innerJoin(schema.users, eq(schema.adminUsers.userId, schema.users.id))
      .where(eq(schema.adminUsers.status, 'pending'))
      .orderBy(schema.adminUsers.createdAt);
    return { items: rows };
  });

  app.post(
    '/admin/admin-requests/:userId/approve',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      await app.db.transaction(async (tx) => {
        const [userRecord] = await tx
          .select({ passwordHash: schema.users.passwordHash })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        const [row] = await tx
          .update(schema.adminUsers)
          .set({ status: 'active', passwordHash: userRecord?.passwordHash ?? null })
          .where(and(eq(schema.adminUsers.userId, userId), eq(schema.adminUsers.status, 'pending')))
          .returning({ userId: schema.adminUsers.userId });
        if (!row) throw new AppError('NOT_FOUND', 404, 'no pending admin request for this user');

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'admin_users.approve',
          resourceType: 'admin_user',
          resourceId: userId,
          after: { status: 'active' },
          request: req,
        });
      });
      return { ok: true, status: 'active' };
    },
  );

  app.post(
    '/admin/admin-requests/:userId/reject',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.adminUsers)
          .set({ status: 'rejected' })
          .where(and(eq(schema.adminUsers.userId, userId), eq(schema.adminUsers.status, 'pending')))
          .returning({ userId: schema.adminUsers.userId });
        if (!row) throw new AppError('NOT_FOUND', 404, 'no pending admin request for this user');

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'admin_users.reject',
          resourceType: 'admin_user',
          resourceId: userId,
          after: { status: 'rejected' },
          request: req,
        });
      });
      return { ok: true, status: 'rejected' };
    },
  );

  app.post(
    '/admin/admin-users',
    {
      preHandler: SUPER,
      schema: {
        body: z.object({
          userId: z.string().uuid(),
          role: z.enum(['ADMIN', 'MODERATOR', 'SUPPORT']).default('ADMIN'),
        }),
      },
    },
    async (req) => {
      const { userId, role } = req.body as { userId: string; role: string };
      await app.db.transaction(async (tx) => {
        const [user] = await tx
          .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');
        await tx
          .insert(schema.adminUsers)
          .values({ userId, role, status: 'active', passwordHash: user.passwordHash })
          .onConflictDoUpdate({
            target: schema.adminUsers.userId,
            set: { role, status: 'active', passwordHash: user.passwordHash },
          });

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'admin_users.update_role',
          resourceType: 'admin_user',
          resourceId: userId,
          after: { role, status: 'active' },
          request: req,
        });
      });
      return { ok: true, role, status: 'active' };
    },
  );

  app.delete(
    '/admin/admin-users/:userId',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      if (userId === req.userId) {
        throw new AppError('FORBIDDEN', 403, 'cannot revoke your own admin access');
      }
      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.adminUsers)
          .where(eq(schema.adminUsers.userId, userId))
          .for('update');
        if (!existing) return;

        await tx.delete(schema.adminUsers).where(eq(schema.adminUsers.userId, userId));

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'admin_users.revoke',
          resourceType: 'admin_user',
          resourceId: userId,
          // Never persist passwordHash into audit_logs — it's copied onto admin_users
          // from users.passwordHash at approval time (see schema comment).
          before: { role: existing.role, status: existing.status },
          request: req,
        });
      });
      return { ok: true };
    },
  );

  app.post(
    '/admin/admin-users/:userId/sync-password',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      await app.db.transaction(async (tx) => {
        const [admin] = await tx
          .select({ status: schema.adminUsers.status })
          .from(schema.adminUsers)
          .where(eq(schema.adminUsers.userId, userId))
          .for('update');
        if (admin?.status !== 'active') {
          throw new AppError('NOT_FOUND', 404, 'no active admin for this user');
        }
        const [user] = await tx
          .select({ passwordHash: schema.users.passwordHash })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');

        await tx
          .update(schema.adminUsers)
          .set({ passwordHash: user.passwordHash })
          .where(eq(schema.adminUsers.userId, userId));

        // Never persist passwordHash itself into audit_logs (see admin_users schema comment).
        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'admin_users.sync_password',
          resourceType: 'admin_user',
          resourceId: userId,
          request: req,
        });
      });
      return { ok: true };
    },
  );
}
