import { schema } from '@tryme/db';
import { WORKER_POOL, workerPoolSchema } from '@tryme/types';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';

const REGISTRY_KEY = 'worker:registry';

function healthKey(id: string) {
  return `worker:health:${id}`;
}

function maskApiKey(key: string): string {
  return key.length > 6 ? `...${key.slice(-6)}` : '******';
}

async function syncToRedis(
  redis: FastifyInstance['redis'],
  id: string,
  fields: {
    url?: string;
    apiKey?: string;
    status?: string;
    lastSeen?: number;
    allowedJobTypes?: string[];
  },
) {
  const raw = await redis.hget(REGISTRY_KEY, id);
  const cur = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  await redis.hset(
    REGISTRY_KEY,
    id,
    JSON.stringify({
      ...cur,
      ...fields,
      allowedJobTypes: fields.allowedJobTypes ?? cur.allowedJobTypes ?? [],
    }),
  );
}

export async function adminWorkersRoutes(app: FastifyInstance) {
  app.get('/admin/workers', { preHandler: requirePermission('workers.read') }, async () => {
    const dbWorkers = await app.db
      .select()
      .from(schema.workers)
      .orderBy(asc(schema.workers.createdAt));
    const results = await Promise.all(
      dbWorkers.map(async (w) => {
        const raw = await app.redis.hget(REGISTRY_KEY, w.id);
        const registry = raw ? (JSON.parse(raw) as { status?: string; lastSeen?: number }) : {};
        const healthy = (await app.redis.get(healthKey(w.id))) === '1';
        return {
          id: w.id,
          label: w.label,
          url: w.url,
          apiKeyHint: maskApiKey(w.apiKey),
          isActive: w.isActive,
          allowedJobTypes: w.allowedJobTypes ?? [],
          status: registry.status ?? (w.isActive ? 'IDLE' : 'DRAINING'),
          healthy,
          lastSeen: registry.lastSeen ?? null,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
        };
      }),
    );
    return results;
  });

  app.get('/admin/workers/job-types', { preHandler: requirePermission('workers.read') }, async () =>
    Object.values(WORKER_POOL),
  );

  app.post(
    '/admin/workers',
    {
      preHandler: requirePermission('workers.write'),
      schema: {
        body: z.object({
          id: z
            .string()
            .min(1)
            .regex(/^[\w-]+$/, 'id must be alphanumeric with dashes'),
          label: z.string().default(''),
          url: z.string().url(),
          apiKey: z.string().min(1),
          allowedJobTypes: z.array(workerPoolSchema).default([]),
        }),
      },
    },
    async (req, reply) => {
      const { id, label, url, apiKey, allowedJobTypes } = req.body as {
        id: string;
        label: string;
        url: string;
        apiKey: string;
        allowedJobTypes: string[];
      };

      const created = await app.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: schema.workers.id })
          .from(schema.workers)
          .where(eq(schema.workers.id, id));
        if (existing.length > 0) {
          throw new AppError('WORKER_EXISTS', 409, 'Worker ID already exists');
        }

        const [row] = await tx
          .insert(schema.workers)
          .values({ id, label, url, apiKey, isActive: true, allowedJobTypes })
          .returning();
        if (!row) {
          throw new AppError('INSERT_FAILED', 500, 'Failed to create worker');
        }

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'worker.create',
          resourceType: 'worker',
          resourceId: row.id,
          after: {
            id: row.id,
            label: row.label,
            url: row.url,
            isActive: row.isActive,
            allowedJobTypes,
          },
          request: req,
        });

        return row;
      });

      await syncToRedis(app.redis, id, {
        url,
        apiKey,
        status: 'IDLE',
        lastSeen: Date.now(),
        allowedJobTypes,
      });

      return reply.code(201).send({
        id: created.id,
        label: created.label,
        url: created.url,
        apiKeyHint: maskApiKey(apiKey),
        isActive: created.isActive,
        allowedJobTypes: created.allowedJobTypes ?? [],
        status: 'IDLE',
        healthy: false,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
    },
  );

  app.patch(
    '/admin/workers/:id',
    {
      preHandler: requirePermission('workers.write'),
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          id: z
            .string()
            .min(1)
            .regex(/^[\w-]+$/, 'id must be alphanumeric with dashes')
            .optional(),
          label: z.string().optional(),
          url: z.string().url().optional(),
          apiKey: z.string().min(1).optional(),
          isActive: z.boolean().optional(),
          allowedJobTypes: z.array(workerPoolSchema).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        id?: string;
        label?: string;
        url?: string;
        apiKey?: string;
        isActive?: boolean;
        allowedJobTypes?: string[];
      };

      const nextId = body.id ?? id;

      const { updated, existing } = await app.db.transaction(async (tx) => {
        const [existingRow] = await tx
          .select()
          .from(schema.workers)
          .where(eq(schema.workers.id, id))
          .for('update');
        if (!existingRow) throw new AppError('NOT_FOUND', 404, 'Worker not found');

        if (nextId !== id) {
          const [conflict] = await tx
            .select({ id: schema.workers.id })
            .from(schema.workers)
            .where(eq(schema.workers.id, nextId));
          if (conflict) {
            throw new AppError('WORKER_EXISTS', 409, 'Worker ID already exists');
          }
        }

        const [row] = await tx
          .update(schema.workers)
          .set({ ...body, id: nextId, updatedAt: new Date() })
          .where(eq(schema.workers.id, id))
          .returning();
        if (!row) {
          throw new AppError('UPDATE_FAILED', 500, 'Failed to update worker');
        }

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'worker.update',
          resourceType: 'worker',
          resourceId: row.id,
          before: {
            id: existingRow.id,
            label: existingRow.label,
            url: existingRow.url,
            isActive: existingRow.isActive,
            allowedJobTypes: existingRow.allowedJobTypes,
          },
          after: {
            id: row.id,
            label: row.label,
            url: row.url,
            isActive: row.isActive,
            allowedJobTypes: row.allowedJobTypes,
          },
          request: req,
        });

        return { updated: row, existing: existingRow };
      });

      if (nextId !== id) {
        const raw = await app.redis.hget(REGISTRY_KEY, id);
        if (raw) {
          await app.redis.hset(REGISTRY_KEY, nextId, raw);
          await app.redis.hdel(REGISTRY_KEY, id);
        }

        const healthy = await app.redis.get(healthKey(id));
        if (healthy !== null) {
          await app.redis.set(healthKey(nextId), healthy);
          await app.redis.del(healthKey(id));
        }
      }

      const newUrl = body.url ?? existing.url;
      const newApiKey = body.apiKey ?? existing.apiKey;
      if (
        nextId !== id ||
        body.url !== undefined ||
        body.apiKey !== undefined ||
        body.allowedJobTypes !== undefined
      ) {
        await syncToRedis(app.redis, nextId, {
          url: newUrl,
          apiKey: newApiKey,
          allowedJobTypes: body.allowedJobTypes,
        });
      }

      if (body.isActive === false) {
        const raw = await app.redis.hget(REGISTRY_KEY, nextId);
        if (raw) {
          const entry = JSON.parse(raw) as Record<string, unknown>;
          entry.status = 'DRAINING';
          await app.redis.hset(REGISTRY_KEY, nextId, JSON.stringify(entry));
        }
      } else if (body.isActive === true) {
        const raw = await app.redis.hget(REGISTRY_KEY, nextId);
        if (raw) {
          const entry = JSON.parse(raw) as Record<string, unknown>;
          if (entry.status === 'DRAINING') {
            entry.status = 'IDLE';
            await app.redis.hset(REGISTRY_KEY, nextId, JSON.stringify(entry));
          }
        }
      }

      const healthy = (await app.redis.get(healthKey(nextId))) === '1';
      const raw = await app.redis.hget(REGISTRY_KEY, nextId);
      const registry = raw ? (JSON.parse(raw) as { status?: string; lastSeen?: number }) : {};

      return {
        id: updated.id,
        label: updated.label,
        url: updated.url,
        apiKeyHint: maskApiKey(updated.apiKey),
        isActive: updated.isActive,
        allowedJobTypes: updated.allowedJobTypes ?? [],
        status: registry.status ?? 'IDLE',
        healthy,
        lastSeen: registry.lastSeen ?? null,
        updatedAt: updated.updatedAt,
      };
    },
  );

  app.delete(
    '/admin/workers/:id',
    {
      preHandler: requirePermission('workers.write'),
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const raw = await app.redis.hget(REGISTRY_KEY, id);
      if (raw) {
        const entry = JSON.parse(raw) as { status?: string };
        if (entry.status === 'BUSY') {
          return reply.code(409).send({
            error: { code: 'WORKER_BUSY', message: 'Cannot delete a BUSY worker - drain it first' },
          });
        }
      }

      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.workers)
          .where(eq(schema.workers.id, id))
          .for('update');
        if (!existing) return;

        await tx.delete(schema.workers).where(eq(schema.workers.id, id));

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'worker.delete',
          resourceType: 'worker',
          resourceId: id,
          before: {
            id: existing.id,
            label: existing.label,
            url: existing.url,
            isActive: existing.isActive,
            allowedJobTypes: existing.allowedJobTypes,
          },
          request: req,
        });
      });

      await app.redis.hdel(REGISTRY_KEY, id);
      await app.redis.del(healthKey(id));

      return reply.code(204).send();
    },
  );

  app.post(
    '/admin/workers/:id/drain',
    {
      preHandler: requirePermission('workers.drain'),
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const raw = await app.redis.hget(REGISTRY_KEY, id);
      if (!raw) return reply.code(404).send({ ok: false });
      const w = JSON.parse(raw) as Record<string, unknown>;
      await app.redis.hset(REGISTRY_KEY, id, JSON.stringify({ ...w, status: 'DRAINING' }));
      return { ok: true };
    },
  );

  app.post(
    '/admin/workers/:id/undrain',
    {
      preHandler: requirePermission('workers.drain'),
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const raw = await app.redis.hget(REGISTRY_KEY, id);
      if (!raw) return reply.code(404).send({ ok: false });
      const w = JSON.parse(raw) as Record<string, unknown>;
      if (w.status === 'DRAINING') {
        await app.redis.hset(REGISTRY_KEY, id, JSON.stringify({ ...w, status: 'IDLE' }));
      }
      return { ok: true };
    },
  );
}
